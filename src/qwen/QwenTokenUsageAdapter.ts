import type { Usage } from "@qwen-code/sdk";
import {
  aggregateTurnTokenUsage,
  createContextTokenUsage,
  type ContextTokenUsage,
  type TurnTokenUsage,
} from "../agent/TokenUsage.js";

type TurnUsagePart = Omit<TurnTokenUsage, "totalTokens" | "accuracy">;

export function adaptQwenTurnUsage(value: unknown): TurnTokenUsage | undefined {
  const part = adaptQwenUsagePart(value);
  if (part === undefined) {
    return undefined;
  }
  const totalTokens = readOptionalToken(value, "total_tokens");
  return {
    ...part,
    totalTokens: totalTokens ?? part.inputTokens + part.outputTokens,
    accuracy: "exact",
  };
}

export function aggregateQwenCallUsages(
  usages: readonly Usage[],
): TurnTokenUsage | undefined {
  return aggregateTurnTokenUsage(
    usages.flatMap((usage) => {
      const part = adaptQwenUsagePart(usage);
      return part === undefined ? [] : [part];
    }),
  );
}

export function adaptQwenContextUsage(
  value: Record<string, unknown> | null,
): ContextTokenUsage | undefined {
  if (value === null) {
    return undefined;
  }
  const usedTokens = readRequiredToken(value, "totalTokens");
  const contextWindowTokens = readRequiredToken(value, "contextWindowSize");
  if (usedTokens === undefined || contextWindowTokens === undefined) {
    return undefined;
  }
  return createContextTokenUsage(
    usedTokens,
    contextWindowTokens,
    value.isEstimated === true ? "estimated" : "exact",
    typeof value.modelName === "string" ? value.modelName : undefined,
  );
}

function adaptQwenUsagePart(value: unknown): TurnUsagePart | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = readRequiredToken(value, "input_tokens");
  const outputTokens = readRequiredToken(value, "output_tokens");
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens:
      readOptionalToken(value, "cache_read_input_tokens") ?? 0,
    cacheCreationInputTokens:
      readOptionalToken(value, "cache_creation_input_tokens") ?? 0,
  };
}

function readRequiredToken(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

function readOptionalToken(value: unknown, key: string): number | undefined {
  return isRecord(value) ? readRequiredToken(value, key) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
