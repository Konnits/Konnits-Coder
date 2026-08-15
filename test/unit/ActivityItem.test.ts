import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActivityItem } from "../../webview/src/ActivityItem.js";

describe("ActivityItem", () => {
  it("renders active emitted thinking through the safe Markdown path", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityItem, {
        node: {
          item: {
            type: "thinking",
            id: "thought-1",
            text: "**Inspecting** <script>alert(1)</script>",
            complete: false,
            startedAt: Date.now() - 2_000,
          },
          children: [],
        },
        expansion: {},
        onToggle: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );
    expect(html).toContain("Thinking…");
    expect(html).toContain("<strong>Inspecting</strong>");
    expect(html).not.toContain("<script>");
  });

  it("renders nested subagent activity inside the agent item", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityItem, {
        node: {
          item: {
            type: "tool",
            id: "agent-1",
            kind: "subagent",
            title: "Agent",
            detail: "Architecture analysis",
            subagentName: "general-purpose",
            state: "running",
          },
          children: [
            {
              item: {
                type: "tool",
                id: "child-read",
                parentId: "agent-1",
                kind: "read",
                title: "Read",
                detail: "package.json",
                state: "succeeded",
              },
              children: [],
            },
          ],
        },
        expansion: {},
        onToggle: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );
    expect(html).toContain("general-purpose");
    expect(html).toContain("nested-activities");
    expect(html).toContain("package.json");
  });
});
