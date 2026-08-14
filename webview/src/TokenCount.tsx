import type {
  MessageTokenCount,
  TurnTokenUsage,
} from "../../src/agent/TokenUsage.js";
import {
  formatFullTokens,
  formatVisibleMessageTokens,
} from "./tokenFormatting.js";

export function TokenCount({
  count,
  turnUsage,
}: {
  readonly count: MessageTokenCount | undefined;
  readonly turnUsage?: TurnTokenUsage;
}): React.JSX.Element | null {
  if (count === undefined) {
    return null;
  }
  const visibleDescription =
    count.accuracy === "estimated"
      ? "Estimated visible message token count"
      : "Exact visible message token count";
  const turnDescription =
    turnUsage === undefined
      ? ""
      : ` Qwen model turn: ${formatFullTokens(turnUsage.inputTokens)} cumulative input and ${formatFullTokens(turnUsage.outputTokens)} output tokens.`;
  const accessibleLabel = `${visibleDescription}: ${formatFullTokens(count.tokens)} tokens.${turnDescription}`;
  return (
    <span
      className="message-token-count"
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {formatVisibleMessageTokens(count)}
    </span>
  );
}
