import type { QwenClientConfiguration } from "../qwen/QwenCodeAgentClient.js";

export function parseConfigurationValues(
  executablePath: string,
  debug: boolean,
): QwenClientConfiguration {
  const normalizedPath = executablePath.trim();
  return {
    ...(normalizedPath.length === 0 ? {} : { executablePath: normalizedPath }),
    debug,
  };
}
