import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../webview/src/vscode.js", () => ({
  vscode: { postMessage: vi.fn() },
}));

import {
  ChangedFilesPanel,
  TodosPanel,
} from "../../webview/src/WorkSummaryPanels.js";

describe("work summary panels", () => {
  it("summarizes todo completion in a collapsed dropdown", () => {
    const html = renderToStaticMarkup(
      createElement(TodosPanel, {
        todos: [
          { id: "one", content: "Inspect", status: "completed" },
          { id: "two", content: "Implement", status: "in_progress" },
        ],
      }),
    );

    expect(html).toContain("Todos");
    expect(html).toContain("(1/2)");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Clear todos"');
    expect(html).toContain("Implement");
  });

  it("summarizes changed files while retaining review actions", () => {
    const html = renderToStaticMarkup(
      createElement(ChangedFilesPanel, {
        changes: [
          {
            id: "change-1",
            path: "src/App.tsx",
            kind: "modified",
            status: "pending",
            additions: 12,
            deletions: 3,
          },
        ],
      }),
    );

    expect(html).toContain("Changed files");
    expect(html).toContain("(1)");
    expect(html).toContain("+12 −3");
    expect(html).toContain('title="Modified"');
    expect(html).toContain("src/App.tsx");
    expect(html).toContain("Keep all");
    expect(html).toContain("Undo all");
    expect(html).toContain("collapsible-panel is-expanded");
    expect(html).not.toContain("collapsible-panel-chevron");
    expect(html).not.toContain("hidden");
  });
});
