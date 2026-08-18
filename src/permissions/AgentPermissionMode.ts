export type AgentPermissionMode = "default" | "plan";

export function parseAgentPermissionMode(value: string): AgentPermissionMode {
  return value === "plan" ? "plan" : "default";
}
