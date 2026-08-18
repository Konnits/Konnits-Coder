import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  scrollSuggestionIntoView,
  SuggestionPopup,
} from "../../webview/src/SuggestionPopup.js";

describe("SuggestionPopup", () => {
  it("renders structured command metadata without dropping long descriptions", () => {
    const description =
      "A deliberately long command description that may wrap at narrow sidebar widths while remaining available to the browser layout.";
    const html = renderToStaticMarkup(
      createElement(SuggestionPopup, {
        id: "suggestions",
        kind: "command",
        commands: [
          {
            id: "qwen:tasks",
            command: "/tasks",
            title: "/tasks",
            description,
            usage: "/tasks",
            aliases: ["/jobs"],
            source: "qwen",
            origin: "qwen",
            executionMode: "qwen-sdk",
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
    expect(html).toContain('id="suggestions-option-0"');
  });

  it("scrolls the keyboard-highlighted option into the visible popup area", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn(() => ({ scrollIntoView }));

    scrollSuggestionIntoView({ querySelector } as unknown as HTMLElement, 7);

    expect(querySelector).toHaveBeenCalledWith('[data-suggestion-index="7"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});
