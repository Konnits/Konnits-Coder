import type { TurnTokenUsage } from "../../src/agent/TokenUsage.js";
import { formatCompactTokens, formatFullTokens } from "./tokenFormatting.js";

export function TurnUsageSummary({
  usage,
}: {
  readonly usage: TurnTokenUsage;
}): React.JSX.Element {
  const details = [
    `Input: ${formatFullTokens(usage.inputTokens)}`,
    `Output: ${formatFullTokens(usage.outputTokens)}`,
    `Cache read: ${formatFullTokens(usage.cacheReadInputTokens)}`,
    `Cache creation: ${formatFullTokens(usage.cacheCreationInputTokens)}`,
  ].join(" · ");
  return (
    <span
      className="turn-usage"
      title={details}
      aria-label={`Turn usage. ${details}`}
    >
      {formatCompactTokens(usage.inputTokens)} input ·{" "}
      {formatCompactTokens(usage.outputTokens)} output
    </span>
  );
}
