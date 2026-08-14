import { describe, expect, it } from "vitest";
import {
  createContextTokenUsage,
  EstimatedTokenCounter,
} from "../../src/agent/TokenUsage.js";
import {
  adaptQwenContextUsage,
  adaptQwenTurnUsage,
  aggregateQwenCallUsages,
} from "../../src/qwen/QwenTokenUsageAdapter.js";
import {
  formatCompactTokens,
  formatTokenCount,
} from "../../webview/src/tokenFormatting.js";

describe("token usage semantics", () => {
  it("calculates current context percentage without using cumulative turn input", () => {
    const context = createContextTokenUsage(42_731, 262_144, "exact");
    const turn = adaptQwenTurnUsage({
      input_tokens: 64_500,
      output_tokens: 800,
      total_tokens: 65_300,
    });

    expect(context?.usedPercentage).toBeCloseTo(16.3, 1);
    expect(context?.usedTokens).toBe(42_731);
    expect(turn?.inputTokens).toBe(64_500);
  });

  it("handles a zero context capacity safely", () => {
    expect(createContextTokenUsage(0, 0, "estimated")).toEqual({
      usedTokens: 0,
      contextWindowTokens: 0,
      remainingTokens: 0,
      usedPercentage: 0,
      accuracy: "estimated",
    });
  });

  it("accepts a lower context value after compaction", () => {
    const before = adaptQwenContextUsage({
      totalTokens: 80_000,
      contextWindowSize: 262_144,
      isEstimated: false,
    });
    const after = adaptQwenContextUsage({
      totalTokens: 31_000,
      contextWindowSize: 262_144,
      isEstimated: false,
    });

    expect(after?.usedTokens).toBeLessThan(before?.usedTokens ?? 0);
  });

  it("formats small and compact token values", () => {
    expect([18, 1_284, 42_731, 262_144].map(formatCompactTokens)).toEqual([
      "18",
      "1.3k",
      "42.7k",
      "262.1k",
    ]);
    expect(formatTokenCount(18, "estimated")).toBe("~18");
    expect(formatTokenCount(18, "exact")).toBe("18");
  });

  it("aggregates per-model-call usage for a turn", () => {
    const usage = aggregateQwenCallUsages([
      usagePart(20_000),
      usagePart(21_500),
      usagePart(23_000),
    ]);
    expect(usage?.inputTokens).toBe(64_500);
  });

  it("always labels the local visible-message fallback as estimated", () => {
    expect(new EstimatedTokenCounter().count("Hola").accuracy).toBe(
      "estimated",
    );
  });
});

function usagePart(inputTokens: number) {
  return { input_tokens: inputTokens, output_tokens: 0 };
}
