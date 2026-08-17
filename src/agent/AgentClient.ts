import type { AgentEvent } from "./AgentEvent.js";
import type { ContextTokenUsage } from "./TokenUsage.js";

export interface Disposable {
  dispose(): void;
}

export interface AgentRunRequest {
  readonly prompt: string;
  readonly workspacePath: string;
  readonly workspacePaths?: readonly string[];
  readonly sessionId: string;
  readonly resume: boolean;
}

export interface AgentSessionRestoreRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface AgentSessionRestoreResult {
  readonly contextUsage?: ContextTokenUsage;
}

export interface AgentClient {
  connect(): Promise<void>;
  run(request: AgentRunRequest): Promise<void>;
  /** Reattach to a persisted session without sending a model prompt. */
  restoreSession?(
    request: AgentSessionRestoreRequest,
  ): Promise<AgentSessionRestoreResult>;
  cancel(): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): Disposable;
  dispose(): Promise<void>;
}
