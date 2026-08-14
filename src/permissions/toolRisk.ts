import type { ToolInput } from "@qwen-code/sdk";
import { isEditTool } from "../changes/toolTargets.js";

export type PermissionRisk = "write" | "command" | "dangerous";

const DANGEROUS_COMMAND =
  /(?:\brm\s+-[^\r\n]*r|\bremove-item\b[^\r\n]*-recurse|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[^\r\n]*f|\b(?:rd|rmdir|del)\s+\/s\b)/iu;

export function classifyToolRisk(
  toolName: string,
  input: ToolInput,
): PermissionRisk {
  const normalized = toolName.toLowerCase();
  if (isEditTool(normalized)) {
    return "write";
  }
  if (normalized === "run_shell_command" || normalized === "shell") {
    const command = typeof input.command === "string" ? input.command : "";
    return DANGEROUS_COMMAND.test(command) ? "dangerous" : "command";
  }
  if (/delete|remove|reset|clean/u.test(normalized)) {
    return "dangerous";
  }
  return "write";
}
