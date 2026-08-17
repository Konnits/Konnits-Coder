import {
  DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
  type QwenClientConfiguration,
} from "../qwen/QwenCodeAgentClient.js";

const MINIMUM_QWEN_STREAM_IDLE_TIMEOUT_MS = 10_000;

export function parseConfigurationValues(
  executablePath: string,
  debug: boolean,
  allowImageInput = false,
  streamIdleTimeoutMs = DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
): QwenClientConfiguration {
  const normalizedPath = executablePath.trim();
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
    ...(allowImageInput ? { allowImageInput: true } : {}),
    ...(normalizedStreamIdleTimeout === DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS
      ? {}
      : { streamIdleTimeoutMs: normalizedStreamIdleTimeout }),
  };
}
