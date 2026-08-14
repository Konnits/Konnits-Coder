import type { SDKMessage } from "@qwen-code/sdk";
import { describe, expect, it } from "vitest";
import {
  describeTool,
  QwenEventAdapter,
} from "../../src/qwen/QwenEventAdapter.js";

describe("QwenEventAdapter", () => {
  it("normalizes partial assistant streaming without exposing raw events", () => {
    const adapter = new QwenEventAdapter();
    const events = [
      adapter.adapt(
        partial({
          type: "message_start",
          message: { id: "m1", role: "assistant", model: "qwen" },
        }),
      ),
      adapter.adapt(
        partial({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        }),
      ),
      adapter.adapt(partial({ type: "message_stop" })),
    ].flat();

    expect(events.map((event) => event.type)).toEqual([
      "assistant.message.started",
      "assistant.message.chunk",
      "assistant.message.completed",
    ]);
    expect(events[1]).toMatchObject({ messageId: "m1", text: "Hello" });
  });

  it("normalizes edit tool start and completion", () => {
    const adapter = new QwenEventAdapter();
    const started = adapter.adapt(
      assistant([
        {
          type: "tool_use",
          id: "tool-1",
          name: "edit",
          input: {
            file_path: "C:/workspace/a.ts",
            old_string: "a",
            new_string: "b",
          },
        },
      ]),
    );
    const completed = adapter.adapt(
      user([
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Successfully modified file",
          is_error: false,
        },
      ]),
    );

    expect(started[0]).toMatchObject({
      type: "tool.started",
      kind: "edit",
      title: "Edit",
      target: "C:/workspace/a.ts",
    });
    expect(completed[0]).toMatchObject({
      type: "tool.completed",
      kind: "edit",
      success: true,
    });
  });

  it("recognizes test commands and failed results", () => {
    const adapter = new QwenEventAdapter();
    adapter.adapt(
      assistant([
        {
          type: "tool_use",
          id: "test-1",
          name: "run_shell_command",
          input: { command: "npm test", is_background: false },
        },
      ]),
    );
    const [completed] = adapter.adapt(
      user([
        {
          type: "tool_result",
          tool_use_id: "test-1",
          content: "2 failed",
          is_error: true,
        },
      ]),
    );

    expect(completed).toMatchObject({
      type: "tool.completed",
      kind: "test",
      title: "Tests",
      success: false,
      output: "2 failed",
    });
  });

  it("summarizes todo writes when item data is available", () => {
    expect(describeTool("todo_write", { todos: [{}, {}, {}] })).toEqual({
      kind: "other",
      title: "Todo Write",
      detail: "3 items",
    });
  });
});

function partial(event: unknown): SDKMessage {
  return {
    type: "stream_event",
    uuid: "stream-1",
    session_id: "session-1",
    parent_tool_use_id: null,
    event,
  } as SDKMessage;
}

function assistant(content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-1",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: {
      id: "assistant-1",
      type: "message",
      role: "assistant",
      model: "qwen",
      content,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as SDKMessage;
}

function user(content: unknown[]): SDKMessage {
  return {
    type: "user",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: { role: "user", content },
  } as SDKMessage;
}
