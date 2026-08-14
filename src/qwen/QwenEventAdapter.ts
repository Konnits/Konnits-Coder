import type {
  ContentBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  ToolInput,
} from "@qwen-code/sdk";
import type {
  AgentActivityKind,
  AgentEvent,
  ToolCompletedEvent,
  ToolStartedEvent,
} from "../agent/AgentEvent.js";
import { getEditTarget } from "../changes/toolTargets.js";

interface ToolRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly kind: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly target?: string;
}

export interface ToolPresentation {
  readonly kind: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly target?: string;
}

export class QwenEventAdapter {
  private readonly tools = new Map<string, ToolRecord>();
  private readonly startedTools = new Set<string>();
  private currentMessageId: string | undefined;
  private sawPartialText = false;

  adapt(message: SDKMessage): readonly AgentEvent[] {
    switch (message.type) {
      case "stream_event":
        return this.adaptPartial(message);
      case "assistant":
        return this.adaptAssistant(message);
      case "user":
        return this.adaptUser(message);
      case "system":
      case "result":
        return [];
    }
  }

  private adaptPartial(
    message: SDKPartialAssistantMessage,
  ): readonly AgentEvent[] {
    const now = Date.now();
    const event = message.event;
    switch (event.type) {
      case "message_start":
        this.currentMessageId = event.message.id;
        this.sawPartialText = false;
        return [
          {
            type: "assistant.message.started",
            messageId: event.message.id,
            timestamp: now,
          },
        ];
      case "content_block_delta":
        if (
          event.delta.type !== "text_delta" ||
          event.delta.text.length === 0
        ) {
          return [];
        }
        this.sawPartialText = true;
        return [
          {
            type: "assistant.message.chunk",
            messageId: this.currentMessageId ?? message.uuid,
            text: event.delta.text,
            timestamp: now,
          },
        ];
      case "message_stop": {
        const messageId = this.currentMessageId ?? message.uuid;
        this.currentMessageId = undefined;
        return [
          {
            type: "assistant.message.completed",
            messageId,
            timestamp: now,
          },
        ];
      }
      case "content_block_start":
      case "content_block_stop":
        return [];
    }
  }

  private adaptAssistant(message: SDKAssistantMessage): readonly AgentEvent[] {
    const events: AgentEvent[] = [];
    const messageId = this.currentMessageId ?? message.uuid;
    const hasStreamingMessage =
      this.currentMessageId !== undefined || this.sawPartialText;
    const content = message.message.content;
    const text = content
      .filter(
        (block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    if (!hasStreamingMessage && text.length > 0) {
      events.push(...this.completeTextMessage(messageId, text));
    }

    for (const block of content) {
      if (block.type === "tool_use") {
        const started = this.startTool(block.id, block.name, block.input);
        if (started !== undefined) {
          events.push(started);
        }
      } else if (block.type === "tool_result") {
        const completed = this.completeTool(
          block.tool_use_id,
          !block.is_error,
          stringifyToolOutput(block.content),
        );
        if (completed !== undefined) {
          events.push(completed);
        }
      }
    }
    return events;
  }

  private adaptUser(message: SDKUserMessage): readonly AgentEvent[] {
    if (typeof message.message.content === "string") {
      return [];
    }
    const events: ToolCompletedEvent[] = [];
    for (const block of message.message.content) {
      if (block.type !== "tool_result") {
        continue;
      }
      const completed = this.completeTool(
        block.tool_use_id,
        !block.is_error,
        stringifyToolOutput(block.content),
      );
      if (completed !== undefined) {
        events.push(completed);
      }
    }
    return events;
  }

  private completeTextMessage(
    messageId: string,
    text: string,
  ): readonly AgentEvent[] {
    const now = Date.now();
    return [
      { type: "assistant.message.started", messageId, timestamp: now },
      { type: "assistant.message.chunk", messageId, text, timestamp: now },
      { type: "assistant.message.completed", messageId, timestamp: now },
    ];
  }

  private startTool(
    callId: string,
    toolName: string,
    rawInput: unknown,
  ): ToolStartedEvent | undefined {
    if (this.startedTools.has(callId)) {
      return undefined;
    }
    const input = asToolInput(rawInput);
    const presentation = describeTool(toolName, input);
    const record: ToolRecord = { callId, toolName, ...presentation };
    this.tools.set(callId, record);
    this.startedTools.add(callId);
    return {
      type: "tool.started",
      ...record,
      timestamp: Date.now(),
    };
  }

  private completeTool(
    callId: string,
    success: boolean,
    output: string | undefined,
  ): ToolCompletedEvent | undefined {
    const record = this.tools.get(callId);
    if (record === undefined) {
      return undefined;
    }
    this.tools.delete(callId);
    return {
      type: "tool.completed",
      ...record,
      success,
      ...(output === undefined ? {} : { output: truncate(output, 4_000) }),
      timestamp: Date.now(),
    };
  }
}

export function describeTool(
  toolName: string,
  input: ToolInput,
): ToolPresentation {
  const normalized = toolName.toLowerCase();
  const editTarget = getEditTarget(normalized, input);
  if (editTarget !== undefined) {
    return {
      kind: "edit",
      title: "Edit",
      detail: editTarget,
      target: editTarget,
    };
  }

  if (normalized === "read_file" || normalized === "read_many_files") {
    const target = firstString(input.path, input.file_path, input.paths);
    return {
      kind: "read",
      title: "Read",
      ...(target === undefined ? {} : { detail: target, target }),
    };
  }

  if (
    normalized === "grep_search" ||
    normalized === "glob" ||
    normalized === "list_directory"
  ) {
    const detail = firstString(input.pattern, input.query, input.path);
    return {
      kind: "search",
      title: normalized === "list_directory" ? "List" : "Search",
      ...(detail === undefined ? {} : { detail }),
    };
  }

  if (normalized === "run_shell_command" || normalized === "shell") {
    const command = firstString(input.command) ?? "Shell command";
    const isTest =
      /(^|\s)(test|pytest|vitest|jest|mocha|cargo test|go test)(\s|$)/iu.test(
        command,
      );
    return {
      kind: isTest ? "test" : "command",
      title: isTest ? "Tests" : "Terminal",
      detail: command,
    };
  }

  if (normalized === "todo_write" || normalized === "write_todos") {
    const todos = Array.isArray(input.todos)
      ? input.todos
      : Array.isArray(input.tasks)
        ? input.tasks
        : undefined;
    return {
      kind: "other",
      title: "Todo Write",
      ...(todos === undefined
        ? {}
        : {
            detail: `${String(todos.length)} ${todos.length === 1 ? "item" : "items"}`,
          }),
    };
  }

  return { kind: "other", title: humanize(toolName) };
}

function asToolInput(value: unknown): ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ToolInput)
    : {};
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (Array.isArray(value)) {
      const strings = value.filter(
        (item): item is string => typeof item === "string",
      );
      if (strings.length > 0) {
        return strings.join(", ");
      }
    }
  }
  return undefined;
}

function stringifyToolOutput(
  content: string | ContentBlock[] | undefined,
): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return undefined;
  }
  const text = content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "thinking") {
        return block.thinking;
      }
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}
