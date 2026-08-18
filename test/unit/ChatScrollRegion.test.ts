import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatScrollRegion } from "../../webview/src/ChatScrollRegion.js";

describe("ChatScrollRegion", () => {
  it("renders the jump control outside the scrolling content", () => {
    const html = renderToStaticMarkup(
      createElement(ChatScrollRegion, {
        contentRef: { current: null },
        following: false,
        onJumpToLatest: vi.fn(),
        children: createElement("span", null, "Conversation"),
      }),
    );

    expect(html).toContain(
      '<div class="chat-body"><span>Conversation</span></div><button class="jump-latest"',
    );
  });

  it("hides the jump control while following the latest content", () => {
    const html = renderToStaticMarkup(
      createElement(ChatScrollRegion, {
        contentRef: { current: null },
        following: true,
        onJumpToLatest: vi.fn(),
        children: "Conversation",
      }),
    );

    expect(html).not.toContain("jump-latest");
  });
});
