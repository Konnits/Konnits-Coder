import type { SDKMessage } from "@qwen-code/sdk";
import { describe, expect, it, vi } from "vitest";
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

  it("completes streamed text once when the full assistant precedes message_stop", () => {
    const adapter = new QwenEventAdapter();
    const events = [
      adapter.adapt(
        partial({
          type: "message_start",
          message: { id: "m-real-order", role: "assistant", model: "qwen" },
        }),
      ),
      adapter.adapt(
        partial({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        }),
      ),
      adapter.adapt(
        assistant([{ type: "text", text: "Hello" }], null, "m-real-order"),
      ),
      adapter.adapt(partial({ type: "message_stop" })),
    ].flat();

    expect(events.map((event) => event.type)).toEqual([
      "assistant.message.started",
      "assistant.message.chunk",
      "assistant.message.completed",
    ]);
    expect(
      events.filter((event) => event.type === "assistant.message.chunk"),
    ).toHaveLength(1);
  });

  it("does not replay streamed text after Qwen rotates the message ID", () => {
    const adapter = new QwenEventAdapter();
    const events = [
      adapter.adapt(
        partial({
          type: "message_start",
          message: { id: "turn-start", role: "assistant", model: "qwen" },
        }),
      ),
      adapter.adapt(
        partial({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "Inspecting" },
        }),
      ),
      adapter.adapt(
        assistant(
          [{ type: "thinking", thinking: "Inspecting" }],
          null,
          "thinking-block",
        ),
      ),
      // Qwen does not emit another message_start for this block transition.
      adapter.adapt(
        partial({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "One copy only." },
        }),
      ),
      adapter.adapt(
        assistant(
          [{ type: "text", text: "One copy only." }],
          null,
          "text-block",
        ),
      ),
      adapter.adapt(partial({ type: "message_stop" })),
    ].flat();

    expect(
      events
        .filter((event) => event.type === "assistant.message.chunk")
        .map((event) => event.text),
    ).toEqual(["One copy only."]);
  });

  it("streams thinking separately, measures its lifetime, and avoids complete-message duplication", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const adapter = new QwenEventAdapter();
      const events = [
        adapter.adapt(
          partial({
            type: "message_start",
            message: { id: "m-thought", role: "assistant", model: "qwen" },
          }),
        ),
        adapter.adapt(
          partial({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Inspect " },
          }),
        ),
        adapter.adapt(
          partial({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "the code." },
          }),
        ),
      ].flat();
      vi.setSystemTime(3_500);
      events.push(
        ...adapter.adapt(partial({ type: "content_block_stop", index: 0 })),
        ...adapter.adapt(partial({ type: "message_stop" })),
        ...adapter.adapt(
          assistant(
            [{ type: "thinking", thinking: "Inspect the code." }],
            null,
            "m-thought",
          ),
        ),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thinking.started",
        "thinking.chunk",
        "thinking.chunk",
        "thinking.completed",
      ]);
      expect(events[3]).toMatchObject({ durationMs: 2_500 });
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "assistant.message.chunk" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adapts non-streamed thinking without mixing it into assistant text", () => {
    const events = new QwenEventAdapter().adapt(
      assistant([
        { type: "thinking", thinking: "Reasoning only" },
        { type: "text", text: "Final text" },
      ]),
    );

    expect(
      events.filter((event) => event.type.startsWith("thinking.")),
    ).toHaveLength(3);
    expect(
      events.find((event) => event.type === "assistant.message.chunk"),
    ).toMatchObject({ text: "Final text" });
  });

  it("preserves subagent ownership for streamed thinking", () => {
    const adapter = new QwenEventAdapter();
    const events = [
      adapter.adapt(
        partial(
          {
            type: "message_start",
            message: { id: "child-message", role: "assistant", model: "qwen" },
          },
          "agent-1",
        ),
      ),
      adapter.adapt(
        partial(
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Inspecting" },
          },
          "agent-1",
        ),
      ),
      adapter.adapt(
        partial({ type: "content_block_stop", index: 0 }, "agent-1"),
      ),
      adapter.adapt(partial({ type: "message_stop" }, "agent-1")),
    ].flat();

    expect(events.map((event) => event.type)).toEqual([
      "thinking.started",
      "thinking.chunk",
      "thinking.completed",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thinking.chunk",
          parentId: "agent-1",
          text: "Inspecting",
        }),
      ]),
    );
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

  it("publishes validated todo state without exposing raw tool input", () => {
    const events = new QwenEventAdapter().adapt(
      assistant([
        {
          type: "tool_use",
          id: "todo-1",
          name: "todo_write",
          input: {
            todos: [
              { id: "inspect", content: "Inspect the UI", status: "completed" },
              {
                id: "build",
                content: "Build the panel",
                status: "in_progress",
              },
            ],
          },
        },
      ]),
    );

    expect(events.map((event) => event.type)).toEqual([
      "tool.started",
      "todos.updated",
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "todos.updated",
        todos: [
          { id: "inspect", content: "Inspect the UI", status: "completed" },
          { id: "build", content: "Build the panel", status: "in_progress" },
        ],
      }),
    );
  });

  it("ignores malformed todo state while retaining the tool activity", () => {
    const events = new QwenEventAdapter().adapt(
      assistant([
        {
          type: "tool_use",
          id: "todo-invalid",
          name: "todo_write",
          input: {
            todos: [{ id: "missing-status", content: "Invalid item" }],
          },
        },
      ]),
    );

    expect(events.map((event) => event.type)).toEqual(["tool.started"]);
  });

  it("maps Qwen agent calls and preserves child parent IDs", () => {
    const adapter = new QwenEventAdapter();
    const [agent] = adapter.adapt(
      assistant([
        {
          type: "tool_use",
          id: "agent-1",
          name: "agent",
          input: {
            description: "Deep repo analysis",
            subagent_type: "general-purpose",
          },
        },
      ]),
    );
    const [child] = adapter.adapt(
      assistant(
        [
          {
            type: "tool_use",
            id: "read-child",
            name: "read_file",
            input: { file_path: "package.json" },
          },
        ],
        "agent-1",
        "child-message",
      ),
    );

    expect(agent).toMatchObject({
      type: "tool.started",
      callId: "agent-1",
      kind: "subagent",
      title: "Agent",
      detail: "Deep repo analysis",
      subagentName: "general-purpose",
    });
    expect(child).toMatchObject({
      type: "tool.started",
      callId: "read-child",
      parentId: "agent-1",
    });
  });
});

function partial(
  event: unknown,
  parentToolUseId: string | null = null,
): SDKMessage {
  return {
    type: "stream_event",
    uuid: `stream-envelope-${String((partialSequence += 1))}`,
    session_id: "session-1",
    parent_tool_use_id: parentToolUseId,
    event,
  } as SDKMessage;
}

let partialSequence = 0;

function assistant(
  content: unknown[],
  parentToolUseId: string | null = null,
  uuid = "assistant-1",
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "session-1",
    parent_tool_use_id: parentToolUseId,
    message: {
      id: uuid,
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
