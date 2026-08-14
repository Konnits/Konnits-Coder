import type {
  MessageTokenCount,
  TokenCountAccuracy,
} from "../../src/agent/TokenUsage.js";

export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  const compact = (tokens / 1_000).toFixed(1).replace(/\.0$/u, "");
  return `${compact}k`;
}

export function formatTokenCount(
  tokens: number,
  accuracy: TokenCountAccuracy,
): string {
  return `${accuracy === "estimated" ? "~" : ""}${formatCompactTokens(tokens)}`;
}

export function formatVisibleMessageTokens(count: MessageTokenCount): string {
  return `${formatTokenCount(count.tokens, count.accuracy)} tokens`;
}

export function formatPercentage(percentage: number): string {
  if (percentage > 0 && percentage < 0.1) {
    return "<0.1";
  }
  return percentage.toFixed(1);
}

export function formatFullTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
