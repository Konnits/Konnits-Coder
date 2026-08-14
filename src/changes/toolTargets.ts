import type { ToolInput } from "@qwen-code/sdk";

const EDIT_TOOLS = new Set(["edit", "write_file", "notebook_edit"]);

export function getEditTarget(
  toolName: string,
  input: ToolInput,
): string | undefined {
  if (!EDIT_TOOLS.has(toolName.toLowerCase())) {
    return undefined;
  }
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName.toLowerCase());
}
