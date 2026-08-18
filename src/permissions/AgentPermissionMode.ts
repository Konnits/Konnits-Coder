export type AgentPermissionMode = "default" | "plan" | "yolo";

export function parseAgentPermissionMode(value: string): AgentPermissionMode {
  return value === "plan" || value === "yolo" ? value : "default";
}
