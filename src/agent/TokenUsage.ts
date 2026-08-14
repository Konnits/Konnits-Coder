export type TokenCountAccuracy = "exact" | "estimated";

export interface MessageTokenCount {
  readonly tokens: number;
  readonly accuracy: TokenCountAccuracy;
}

export interface TurnTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly totalTokens: number;
  readonly accuracy: "exact";
}

export interface ContextTokenUsage {
  readonly usedTokens: number;
  readonly contextWindowTokens: number;
  readonly remainingTokens: number;
  readonly usedPercentage: number;
  readonly accuracy: TokenCountAccuracy;
  readonly modelName?: string;
}

export interface TokenCounter {
  count(text: string): MessageTokenCount;
}

export class EstimatedTokenCounter implements TokenCounter {
  count(text: string): MessageTokenCount {
    if (text.length === 0) {
      return { tokens: 0, accuracy: "estimated" };
    }

    // Qwen Code does not expose a public message-only tokenizer. UTF-8 bytes
    // divided by four is deliberately model-independent and is never presented
    // as an exact count.
    return {
      tokens: Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4)),
      accuracy: "estimated",
    };
  }
}

export function createContextTokenUsage(
  usedTokens: number,
  contextWindowTokens: number,
  accuracy: TokenCountAccuracy,
  modelName?: string,
): ContextTokenUsage | undefined {
  if (
    !isNonNegativeInteger(usedTokens) ||
    !isNonNegativeInteger(contextWindowTokens)
  ) {
    return undefined;
  }
  return {
    usedTokens,
    contextWindowTokens,
    remainingTokens: Math.max(0, contextWindowTokens - usedTokens),
    usedPercentage:
      contextWindowTokens === 0 ? 0 : (usedTokens / contextWindowTokens) * 100,
    accuracy,
    ...(modelName === undefined ? {} : { modelName }),
  };
}

export function aggregateTurnTokenUsage(
  usages: readonly Omit<TurnTokenUsage, "totalTokens" | "accuracy">[],
): TurnTokenUsage | undefined {
  if (usages.length === 0) {
    return undefined;
  }
  const totals = usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadInputTokens:
        total.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  );
  return {
    ...totals,
    totalTokens: totals.inputTokens + totals.outputTokens,
    accuracy: "exact",
  };
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
