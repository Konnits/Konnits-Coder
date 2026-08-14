import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  isSafeExternalHref,
  MarkdownMessage,
} from "../../webview/src/MarkdownMessage.js";

describe("MarkdownMessage", () => {
  it("renders representative GFM as semantic React output", () => {
    const source = [
      "### Heading",
      "",
      "A **bold** paragraph.",
      "",
      "- first",
      "- second",
      "",
      "```typescript",
      "const value = true;",
      "```",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| **A** | `1` |",
    ].join("\n");
    const html = render(source);

    expect(html).toContain("<h3>Heading</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('class="markdown-table-scroll"');
    expect(html).toContain("<table>");
  });

  it("does not render raw model HTML", () => {
    const html = render('<script>alert("bad")</script>\n\n# Safe');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(&quot;bad&quot;)");
    expect(html).toContain("<h1>Safe</h1>");
  });

  it("allows only explicit external schemes", () => {
    expect(isSafeExternalHref("https://example.com")).toBe(true);
    expect(isSafeExternalHref("mailto:user@example.com")).toBe(true);
    expect(isSafeExternalHref("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalHref("README.md")).toBe(false);
  });
});

function render(source: string): string {
  return renderToStaticMarkup(
    createElement(MarkdownMessage, {
      source,
      onOpenLink: vi.fn(),
    }),
  );
}
