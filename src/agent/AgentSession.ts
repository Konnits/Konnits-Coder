export interface AgentSession {
  readonly id: string;
  readonly workspaceKey: string;
  readonly createdAt: number;
  readonly established?: boolean;
}
