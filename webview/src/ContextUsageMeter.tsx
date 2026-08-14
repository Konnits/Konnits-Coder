import type { ContextTokenUsage } from "../../src/agent/TokenUsage.js";
import {
  formatFullTokens,
  formatPercentage,
  formatTokenCount,
} from "./tokenFormatting.js";

export function ContextUsageMeter({
  usage,
}: {
  readonly usage: ContextTokenUsage;
}): React.JSX.Element {
  const visualPercentage = Math.min(100, Math.max(0, usage.usedPercentage));
  const estimated = usage.accuracy === "estimated";
  const percentage = `${estimated ? "~" : ""}${formatPercentage(usage.usedPercentage)}%`;
  const title = `${estimated ? "Estimated current context" : "Current context"}: ${formatFullTokens(usage.usedTokens)} of ${formatFullTokens(usage.contextWindowTokens)} tokens, ${percentage} used, ${formatFullTokens(usage.remainingTokens)} remaining${usage.modelName === undefined ? "" : ` · ${usage.modelName}`}`;
  const progressValues =
    usage.contextWindowTokens === 0
      ? {}
      : {
          "aria-valuemin": 0,
          "aria-valuemax": usage.contextWindowTokens,
          "aria-valuenow": Math.min(
            usage.usedTokens,
            usage.contextWindowTokens,
          ),
        };
  return (
    <section
      className="context-meter"
      aria-label="Current model context usage"
      title={title}
    >
      <div className="context-meter-label">
        <strong>Context</strong>
        <span>
          {formatTokenCount(usage.usedTokens, usage.accuracy)} /{" "}
          {formatTokenCount(usage.contextWindowTokens, "exact")}
        </span>
        <span>{percentage}</span>
      </div>
      <div
        className="context-progress"
        role="progressbar"
        aria-label={title}
        aria-valuetext={`${percentage} used`}
        {...progressValues}
      >
        <span style={{ width: `${String(visualPercentage)}%` }} />
      </div>
    </section>
  );
}
