import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SuggestionPopup } from "../../webview/src/SuggestionPopup.js";

describe("SuggestionPopup", () => {
  it("renders structured command metadata without dropping long descriptions", () => {
    const description =
      "A deliberately long command description that may wrap at narrow sidebar widths while remaining available to the browser layout.";
    const html = renderToStaticMarkup(
      createElement(SuggestionPopup, {
        kind: "command",
        commands: [
          {
            name: "/tasks",
            description,
            usage: "/tasks",
            aliases: ["jobs"],
            source: "qwen",
            available: true,
          },
        ],
        references: [],
        highlightedIndex: 0,
        onHighlight: vi.fn(),
        onSelectCommand: vi.fn(),
        onSelectReference: vi.fn(),
      }),
    );

    expect(html).toContain("/tasks");
    expect(html).toContain(description);
    expect(html).toContain("Usage: /tasks");
    expect(html).toContain("Aliases: /jobs");
    expect(html).toContain("Qwen");
    expect(html).toContain("suggestion-selected");
  });
});
