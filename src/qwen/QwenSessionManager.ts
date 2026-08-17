import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import type { AgentSession } from "../agent/AgentSession.js";

export interface SessionSelection {
  readonly session: AgentSession;
  readonly resume: boolean;
}

export class QwenSessionManager {
  private current: AgentSession | undefined;

  constructor(
    private readonly state: vscode.Memento,
    private readonly workspaceKey: string,
  ) {}

  async getOrCreate(): Promise<SessionSelection> {
    if (this.current !== undefined) {
      return {
        session: this.current,
        resume: this.current.established !== false,
      };
    }
    const stored = this.state.get<AgentSession>(this.storageKey());
    if (isStoredSession(stored, this.workspaceKey)) {
      this.current = stored;
      return { session: stored, resume: true };
    }
    return { session: await this.create(), resume: false };
  }

  getKnownSessionId(): string | undefined {
    const candidate =
      this.current ?? this.state.get<AgentSession>(this.storageKey());
    return isStoredSession(candidate, this.workspaceKey) &&
      candidate.established !== false
      ? candidate.id
      : undefined;
  }

  async create(): Promise<AgentSession> {
    const session: AgentSession = {
      id: randomUUID(),
      workspaceKey: this.workspaceKey,
      createdAt: Date.now(),
      established: false,
    };
    this.current = session;
    await this.state.update(this.storageKey(), session);
    return session;
  }

  async resumeExisting(sessionId: string): Promise<SessionSelection> {
    const existing = this.current?.id === sessionId ? this.current : undefined;
    const session: AgentSession = existing ?? {
      id: sessionId,
      workspaceKey: this.workspaceKey,
      createdAt: Date.now(),
      established: true,
    };
    this.current = { ...session, established: true };
    await this.state.update(this.storageKey(), this.current);
    return { session: this.current, resume: true };
  }

  async markEstablished(sessionId: string): Promise<void> {
    if (this.current?.id !== sessionId || this.current.established === true) {
      return;
    }
    this.current = { ...this.current, established: true };
    await this.state.update(this.storageKey(), this.current);
  }

  private storageKey(): string {
    return `qwenFrontend.session.${this.workspaceKey}`;
  }
}

function isStoredSession(
  value: AgentSession | undefined,
  workspaceKey: string,
): value is AgentSession {
  return (
    value !== undefined &&
    typeof value.id === "string" &&
    value.workspaceKey === workspaceKey &&
    typeof value.createdAt === "number" &&
    (value.established === undefined || typeof value.established === "boolean")
  );
}
