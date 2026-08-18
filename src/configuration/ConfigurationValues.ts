import {
  DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
  type QwenClientConfiguration,
} from "../qwen/QwenCodeAgentClient.js";
import { parseAgentPermissionMode } from "../permissions/AgentPermissionMode.js";

const MINIMUM_QWEN_STREAM_IDLE_TIMEOUT_MS = 10_000;

export function parseConfigurationValues(
  executablePath: string,
  debug: boolean,
  allowImageInput = false,
  streamIdleTimeoutMs = DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
  permissionMode = "default",
): QwenClientConfiguration {
  const normalizedPath = executablePath.trim();
  const normalizedPermissionMode = parseAgentPermissionMode(permissionMode);
  // Zero is a sentinel meaning "no inactivity timeout".
  const normalizedStreamIdleTimeout =
    streamIdleTimeoutMs === 0 ||
    (Number.isInteger(streamIdleTimeoutMs) &&
      streamIdleTimeoutMs >= MINIMUM_QWEN_STREAM_IDLE_TIMEOUT_MS)
      ? streamIdleTimeoutMs
      : DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS;
  return {
    ...(normalizedPath.length === 0 ? {} : { executablePath: normalizedPath }),
    debug,
    ...(normalizedPermissionMode === "default"
      ? {}
      : { permissionMode: normalizedPermissionMode }),
    ...(allowImageInput ? { allowImageInput: true } : {}),
    ...(normalizedStreamIdleTimeout === DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS
      ? {}
      : { streamIdleTimeoutMs: normalizedStreamIdleTimeout }),
  };
}
