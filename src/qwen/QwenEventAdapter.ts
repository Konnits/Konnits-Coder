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
  AgentTodo,
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
  readonly parentId?: string;
  readonly subagentName?: string;
  readonly background?: boolean;
}

export interface ToolPresentation {
  readonly kind: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly target?: string;
  readonly subagentName?: string;
  readonly background?: boolean;
}

interface ThoughtStreamState {
  readonly thoughtId: string;
  readonly startedAt: number;
  completed: boolean;
}

interface MessageStreamState {
  readonly messageId: string;
  readonly parentId?: string;
  readonly thoughts: Map<number, ThoughtStreamState>;
  assistantStarted: boolean;
}

export class QwenEventAdapter {
  private readonly tools = new Map<string, ToolRecord>();
  private readonly startedTools = new Set<string>();
  private readonly streams = new Map<string, MessageStreamState>();
  private readonly streamedMessageUuids = new Set<string>();

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
      case "message_start": {
        const state: MessageStreamState = {
          messageId: event.message.id,
          ...(message.parent_tool_use_id === null
            ? {}
            : { parentId: message.parent_tool_use_id }),
          thoughts: new Map(),
          assistantStarted: false,
        };
        this.streams.set(streamKey(message), state);
        this.streamedMessageUuids.add(event.message.id);
        return [];
      }
      case "content_block_start": {
        const state = this.ensureStream(message);
        if (event.content_block.type !== "thinking") {
          return [];
        }
        return this.startThought(
          state,
          event.index,
          event.content_block.thinking,
          now,
        );
      }
      case "content_block_delta":
        if (event.delta.type === "thinking_delta") {
          if (event.delta.thinking.length === 0) {
            return [];
          }
          const state = this.ensureStream(message);
          const events = this.startThought(state, event.index, "", now);
          const thought = state.thoughts.get(event.index);
          if (thought !== undefined) {
            events.push({
              type: "thinking.chunk",
              thoughtId: thought.thoughtId,
              text: event.delta.thinking,
              ...(state.parentId === undefined
                ? {}
                : { parentId: state.parentId }),
              timestamp: now,
            });
          }
          return events;
        }
        if (
          event.delta.type !== "text_delta" ||
          event.delta.text.length === 0
        ) {
          return [];
        }
        {
          const state = this.ensureStream(message);
          const events: AgentEvent[] = [];
          if (!state.assistantStarted) {
            state.assistantStarted = true;
            events.push({
              type: "assistant.message.started",
              messageId: state.messageId,
              ...(state.parentId === undefined
                ? {}
                : { parentId: state.parentId }),
              timestamp: now,
            });
          }
          events.push({
            type: "assistant.message.chunk",
            messageId: state.messageId,
            text: event.delta.text,
            ...(state.parentId === undefined
              ? {}
              : { parentId: state.parentId }),
            timestamp: now,
          });
          return events;
        }
      case "content_block_stop": {
        const state = this.ensureStream(message);
        const thought = state.thoughts.get(event.index);
        if (thought === undefined || thought.completed) {
          return [];
        }
        thought.completed = true;
        return [this.completeThought(state, thought, now)];
      }
      case "message_stop": {
        const state = this.streams.get(streamKey(message));
        if (state === undefined) {
          return [];
        }
        const events: AgentEvent[] = [];
        for (const thought of state.thoughts.values()) {
          if (!thought.completed) {
            thought.completed = true;
            events.push(this.completeThought(state, thought, now));
          }
        }
        if (state.assistantStarted) {
          events.push({
            type: "assistant.message.completed",
            messageId: state.messageId,
            ...(state.parentId === undefined
              ? {}
              : { parentId: state.parentId }),
            timestamp: now,
          });
        }
        this.streams.delete(streamKey(message));
        return events;
      }
    }
  }

  private adaptAssistant(message: SDKAssistantMessage): readonly AgentEvent[] {
    const events: AgentEvent[] = [];
    const stream = this.streams.get(streamKey(message));
    const messageId = stream?.messageId ?? message.uuid;
    const parentId = message.parent_tool_use_id ?? undefined;
    // Qwen emits message_start only once for a model turn, but may rotate the
    // assistant message ID when thinking, text, and tool blocks transition.
    // Presence of streamed content on the active parent stream is therefore
    // authoritative; comparing only UUIDs replays the completed block.
    const hasStreamingMessage =
      (stream !== undefined &&
        (stream.assistantStarted || stream.thoughts.size > 0)) ||
      this.streamedMessageUuids.has(message.uuid);
    const content = message.message.content;
    const text = content
      .filter(
        (block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    if (!hasStreamingMessage && text.length > 0) {
      events.push(...this.completeTextMessage(messageId, text, parentId));
    } else if (
      hasStreamingMessage &&
      stream?.assistantStarted === true &&
      text.length > 0
    ) {
      events.push({
        type: "assistant.message.completed",
        messageId,
        ...(parentId === undefined ? {} : { parentId }),
        timestamp: Date.now(),
      });
    }
    if (stream !== undefined) {
      const now = Date.now();
      for (const thought of stream.thoughts.values()) {
        if (!thought.completed) {
          thought.completed = true;
          events.push(this.completeThought(stream, thought, now));
        }
      }
    }

    for (const [index, block] of content.entries()) {
      if (block.type === "thinking" && !hasStreamingMessage) {
        const now = Date.now();
        const thoughtId = `${messageId}:thinking:${String(index)}`;
        events.push({
          type: "thinking.started",
          thoughtId,
          ...(parentId === undefined ? {} : { parentId }),
          timestamp: now,
        });
        if (block.thinking.length > 0) {
          events.push({
            type: "thinking.chunk",
            thoughtId,
            text: block.thinking,
            ...(parentId === undefined ? {} : { parentId }),
            timestamp: now,
          });
        }
        events.push({
          type: "thinking.completed",
          thoughtId,
          ...(parentId === undefined ? {} : { parentId }),
          durationMs: 0,
          timestamp: now,
        });
      }
      if (block.type === "tool_use") {
        const started = this.startTool(
          block.id,
          block.name,
          block.input,
          parentId,
        );
        if (started !== undefined) {
          events.push(started);
          const todos = parseTodos(block.name, block.input);
          if (todos !== undefined) {
            events.push({
              type: "todos.updated",
              todos,
              ...(parentId === undefined ? {} : { parentId }),
              timestamp: Date.now(),
            });
          }
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
    this.streams.delete(streamKey(message));
    if (stream !== undefined) {
      this.streamedMessageUuids.delete(stream.messageId);
    }
    this.streamedMessageUuids.delete(message.uuid);
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
    parentId: string | undefined,
  ): readonly AgentEvent[] {
    const now = Date.now();
    return [
      {
        type: "assistant.message.started",
        messageId,
        ...(parentId === undefined ? {} : { parentId }),
        timestamp: now,
      },
      {
        type: "assistant.message.chunk",
        messageId,
        text,
        ...(parentId === undefined ? {} : { parentId }),
        timestamp: now,
      },
      {
        type: "assistant.message.completed",
        messageId,
        ...(parentId === undefined ? {} : { parentId }),
        timestamp: now,
      },
    ];
  }

  private startTool(
    callId: string,
    toolName: string,
    rawInput: unknown,
    parentId: string | undefined,
  ): ToolStartedEvent | undefined {
    if (this.startedTools.has(callId)) {
      return undefined;
    }
    const input = asToolInput(rawInput);
    const presentation = describeTool(toolName, input);
    const record: ToolRecord = {
      callId,
      toolName,
      ...presentation,
      ...(parentId === undefined ? {} : { parentId }),
    };
    this.tools.set(callId, record);
    this.startedTools.add(callId);
    return {
      type: "tool.started",
      ...record,
      timestamp: Date.now(),
    };
  }

  private ensureStream(
    message: SDKPartialAssistantMessage,
  ): MessageStreamState {
    const key = streamKey(message);
    const existing = this.streams.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const state: MessageStreamState = {
      messageId: message.uuid,
      ...(message.parent_tool_use_id === null
        ? {}
        : { parentId: message.parent_tool_use_id }),
      thoughts: new Map(),
      assistantStarted: false,
    };
    this.streams.set(key, state);
    this.streamedMessageUuids.add(message.uuid);
    return state;
  }

  private startThought(
    state: MessageStreamState,
    index: number,
    initialText: string,
    now: number,
  ): AgentEvent[] {
    let thought = state.thoughts.get(index);
    const events: AgentEvent[] = [];
    if (thought === undefined) {
      thought = {
        thoughtId: `${state.messageId}:thinking:${String(index)}`,
        startedAt: now,
        completed: false,
      };
      state.thoughts.set(index, thought);
      events.push({
        type: "thinking.started",
        thoughtId: thought.thoughtId,
        ...(state.parentId === undefined ? {} : { parentId: state.parentId }),
        timestamp: now,
      });
    }
    if (initialText.length > 0) {
      events.push({
        type: "thinking.chunk",
        thoughtId: thought.thoughtId,
        text: initialText,
        ...(state.parentId === undefined ? {} : { parentId: state.parentId }),
        timestamp: now,
      });
    }
    return events;
  }

  private completeThought(
    state: MessageStreamState,
    thought: ThoughtStreamState,
    now: number,
  ): AgentEvent {
    return {
      type: "thinking.completed",
      thoughtId: thought.thoughtId,
      ...(state.parentId === undefined ? {} : { parentId: state.parentId }),
      durationMs: Math.max(0, now - thought.startedAt),
      timestamp: now,
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

function streamKey(message: {
  readonly parent_tool_use_id: string | null;
}): string {
  return message.parent_tool_use_id ?? "main";
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

  if (normalized === "agent" || normalized === "task") {
    const description = firstString(input.description, input.prompt);
    const subagentName = firstString(input.subagent_type) ?? "general-purpose";
    return {
      kind: "subagent",
      title: "Agent",
      ...(description === undefined ? {} : { detail: description }),
      subagentName,
      ...(typeof input.run_in_background === "boolean"
        ? { background: input.run_in_background }
        : {}),
    };
  }

  return { kind: "other", title: humanize(toolName) };
}

function asToolInput(value: unknown): ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ToolInput)
    : {};
}

function parseTodos(
  toolName: string,
  rawInput: unknown,
): readonly AgentTodo[] | undefined {
  const normalized = toolName.toLowerCase();
  if (normalized !== "todo_write" && normalized !== "write_todos") {
    return undefined;
  }
  if (!isRecord(rawInput)) {
    return undefined;
  }
  const values: readonly unknown[] | undefined = Array.isArray(rawInput.todos)
    ? rawInput.todos
    : Array.isArray(rawInput.tasks)
      ? rawInput.tasks
      : undefined;
  if (values === undefined) {
    return undefined;
  }

  const todos: AgentTodo[] = [];
  for (const value of values) {
    if (
      !isRecord(value) ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      value.id.trim().length === 0 ||
      !("content" in value) ||
      typeof value.content !== "string" ||
      value.content.trim().length === 0 ||
      !("status" in value) ||
      (value.status !== "pending" &&
        value.status !== "in_progress" &&
        value.status !== "completed")
    ) {
      return undefined;
    }
    todos.push({
      id: value.id,
      content: value.content,
      status: value.status,
    });
  }
  return todos;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
