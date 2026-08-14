export type AgentActivityKind =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "test"
  | "other";

export interface AgentStartedEvent {
  readonly type: "agent.started";
  readonly runId: string;
  readonly sessionId: string;
  readonly timestamp: number;
}

export interface AssistantMessageStartedEvent {
  readonly type: "assistant.message.started";
  readonly messageId: string;
  readonly timestamp: number;
}

export interface AssistantMessageChunkEvent {
  readonly type: "assistant.message.chunk";
  readonly messageId: string;
  readonly text: string;
  readonly timestamp: number;
}

export interface AssistantMessageCompletedEvent {
  readonly type: "assistant.message.completed";
  readonly messageId: string;
  readonly timestamp: number;
}

export interface ToolStartedEvent {
  readonly type: "tool.started";
  readonly callId: string;
  readonly toolName: string;
  readonly kind: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly target?: string;
  readonly timestamp: number;
}

export interface ToolCompletedEvent {
  readonly type: "tool.completed";
  readonly callId: string;
  readonly toolName: string;
  readonly kind: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly target?: string;
  readonly success: boolean;
  readonly output?: string;
  readonly timestamp: number;
}

export interface AgentCompletedEvent {
  readonly type: "agent.completed";
  readonly runId: string;
  readonly result?: string;
  readonly turnUsage?: import("./TokenUsage.js").TurnTokenUsage;
  readonly timestamp: number;
}

export interface ContextUsageUpdatedEvent {
  readonly type: "context.usage.updated";
  readonly sessionId: string;
  readonly usage: import("./TokenUsage.js").ContextTokenUsage;
  readonly timestamp: number;
}

export interface AgentFailedEvent {
  readonly type: "agent.failed";
  readonly runId: string;
  readonly message: string;
  readonly timestamp: number;
}

export interface AgentCancelledEvent {
  readonly type: "agent.cancelled";
  readonly runId: string;
  readonly timestamp: number;
}

export type AgentEvent =
  | AgentStartedEvent
  | AssistantMessageStartedEvent
  | AssistantMessageChunkEvent
  | AssistantMessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ContextUsageUpdatedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentCancelledEvent;
