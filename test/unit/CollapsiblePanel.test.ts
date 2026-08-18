import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollapsiblePanel } from "../../webview/src/CollapsiblePanel.js";

describe("CollapsiblePanel", () => {
  it("renders a compact, accessible collapsed summary", () => {
    const html = renderToStaticMarkup(
      createElement(CollapsiblePanel, {
        title: "Todos",
        count: "4/4",
        meta: "Complete",
        children: createElement("span", null, "Hidden task"),
      }),
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Todos");
    expect(html).toContain("(4/4)");
    expect(html).toContain('hidden=""');
  });

  it("can render its dropdown content expanded", () => {
    const html = renderToStaticMarkup(
      createElement(CollapsiblePanel, {
        title: "Changed files",
        count: "2",
        defaultExpanded: true,
        children: createElement("span", null, "src/App.tsx"),
      }),
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("src/App.tsx");
    expect(html).not.toContain('hidden=""');
  });
});
