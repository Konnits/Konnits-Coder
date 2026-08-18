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

  it("keeps nested thinking discoverable after the subagent completes", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityItem, {
        node: {
          item: {
            type: "tool",
            id: "agent-completed",
            kind: "subagent",
            title: "Agent",
            detail: "Analyze architecture",
            subagentName: "Explore",
            state: "succeeded",
          },
          children: [
            {
              item: {
                type: "thinking",
                id: "child-thought",
                parentId: "agent-completed",
                text: "Tracing the event flow",
                complete: true,
                startedAt: 1_000,
                durationMs: 2_000,
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

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Thought for 2s");
    expect(html).toContain("Tracing the event flow");
  });

  it("does not leave a cancelled tool in the running state", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityItem, {
        node: {
          item: {
            type: "tool",
            id: "cancelled-tool",
            kind: "read",
            title: "Read",
            state: "cancelled",
          },
          children: [],
        },
        expansion: {},
        onToggle: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );
    expect(html).toContain("activity-cancelled");
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("Running");
  });

  it("renders an active-turn user update as a distinct processing entry", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityItem, {
        node: {
          item: {
            type: "followUp",
            id: "follow-up-1",
            text: "Prioritize keyboard navigation",
          },
          children: [],
        },
        expansion: { "follow-up-1": true },
        onToggle: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );

    expect(html).toContain("activity-kind-followUp");
    expect(html).toContain("You");
    expect(html).toContain("Prioritize keyboard navigation");
  });
});
