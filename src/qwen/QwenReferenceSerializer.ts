import { fileURLToPath } from "node:url";
import type { ChatReference } from "../webview/messages.js";

export interface QwenReferenceSerializationOptions {
  readonly primaryWorkspaceFolderUri?: string;
}

const QWEN_SPECIAL_PATH_CHARACTERS = new Set([
  " ",
  "\t",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ";",
  "|",
  "*",
  "?",
  "$",
  "`",
  "'",
  '"',
  "#",
  "&",
  "<",
  ">",
  "!",
  "~",
  ",",
]);

export function serializeQwenPrompt(
  visibleText: string,
  references: readonly ChatReference[],
  options: QwenReferenceSerializationOptions = {},
): string {
  const referenceText = references
    .map((reference) => serializeQwenReference(reference, options))
    .join(" ");
  const text = visibleText.trim();
  return [referenceText, text].filter((part) => part.length > 0).join(" ");
}

export function serializeQwenReference(
  reference: ChatReference,
  options: QwenReferenceSerializationOptions = {},
): string {
  const useAbsolutePath =
    options.primaryWorkspaceFolderUri !== undefined &&
    reference.workspaceFolderUri !== options.primaryWorkspaceFolderUri;
  const path = useAbsolutePath
    ? uriToPath(reference.uri)
    : validateRelativePath(reference.relativePath);
  return `@${escapeQwenPath(path)}`;
}

export function escapeQwenPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  let escaped = "";
  for (const character of normalized) {
    if (QWEN_SPECIAL_PATH_CHARACTERS.has(character)) {
      escaped += "\\";
    }
    escaped += character;
  }
  return escaped;
}

function validateRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Invalid workspace-relative Qwen reference: ${value}`);
  }
  return normalized;
}

function uriToPath(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  if (/^[A-Za-z]:[\\/]/u.test(uri) || uri.startsWith("\\\\")) {
    return uri;
  }
  throw new Error(`Unsupported Qwen reference URI: ${uri}`);
}
