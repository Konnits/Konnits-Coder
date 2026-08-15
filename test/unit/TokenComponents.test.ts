import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextUsageMeter } from "../../webview/src/ContextUsageMeter.js";
import { TokenCount } from "../../webview/src/TokenCount.js";
import { TurnUsageSummary } from "../../webview/src/TurnUsageSummary.js";

describe("token metric components", () => {
  it("renders estimated and exact values with distinct labels", () => {
    const estimated = renderToStaticMarkup(
      createElement(TokenCount, {
        count: { tokens: 18, accuracy: "estimated" },
      }),
    );
    const exact = renderToStaticMarkup(
      createElement(TokenCount, {
        count: { tokens: 18, accuracy: "exact" },
      }),
    );
    expect(estimated).toContain("~18 tokens");
    expect(estimated).toContain("Estimated visible message token count");
    expect(exact).toContain(">18 tokens<");
    expect(exact).not.toContain("~18");
  });

  it("renders an accessible context progress meter", () => {
    const html = renderToStaticMarkup(
      createElement(ContextUsageMeter, {
        usage: {
          usedTokens: 42_731,
          contextWindowTokens: 262_144,
          remainingTokens: 219_413,
          usedPercentage: (42_731 / 262_144) * 100,
          accuracy: "exact",
        },
      }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("42.7k / 262.1k");
    expect(html).toContain("16.3%");
    expect(html).toContain('aria-valuenow="42731"');
  });

  it("renders authoritative turn totals separately from context usage", () => {
    const html = renderToStaticMarkup(
      createElement(TurnUsageSummary, {
        usage: {
          inputTokens: 71_800,
          outputTokens: 3_600,
          cacheReadInputTokens: 52_400,
          cacheCreationInputTokens: 0,
          totalTokens: 75_400,
          accuracy: "exact",
        },
      }),
    );
    expect(html).toContain("71.8k input");
    expect(html).toContain("3.6k output");
    expect(html).toContain("Cache read: 52,400");
    expect(html).not.toContain("262.1k");
  });
});
