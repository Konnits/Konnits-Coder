import type { AgentEvent } from "./AgentEvent.js";

export interface Disposable {
  dispose(): void;
}

export interface AgentRunRequest {
  readonly prompt: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly resume: boolean;
}

export interface AgentClient {
  connect(): Promise<void>;
  run(request: AgentRunRequest): Promise<void>;
  cancel(): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): Disposable;
  dispose(): Promise<void>;
}
