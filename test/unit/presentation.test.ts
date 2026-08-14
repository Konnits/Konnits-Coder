import { describe, expect, it } from "vitest";
import type {
  AssistantTimelineItem,
  TimelineItem,
  ToolTimelineItem,
} from "../../src/webview/messages.js";
import {
  activitySummary,
  buildConversationView,
  initialProcessingExpansion,
  isActivityExpanded,
  processingSummary,
  setProcessingExpanded,
  toggleActivityExpansion,
  updateProcessingExpansion,
} from "../../webview/src/presentation.js";

describe("processing presentation", () => {
  it("summarizes completed tool steps", () => {
    const tools = Array.from({ length: 11 }, (_, index) =>
      tool(`tool-${String(index)}`),
    );
    expect(processingSummary(tools, "completed")).toBe("11 steps · Completed");
  });

  it("uses workspace-relative activity summaries", () => {
    expect(
      activitySummary(
        tool("read", "C:\\workspace\\src\\foo.ts"),
        "C:\\workspace",
      ),
    ).toBe("src/foo.ts");
  });

  it("auto-collapses completion, respects overrides, and expands attention states", () => {
    const running = initialProcessingExpansion("working");
    expect(running.expanded).toBe(true);
    expect(updateProcessingExpansion(running, "completed").expanded).toBe(
      false,
    );

    const manuallyExpanded = setProcessingExpanded(
      setProcessingExpanded(running, false),
      true,
    );
    expect(
      updateProcessingExpansion(manuallyExpanded, "completed").expanded,
    ).toBe(true);
    expect(
      updateProcessingExpansion(setProcessingExpanded(running, false), "failed")
        .expanded,
    ).toBe(true);
  });

  it("preserves independent nested activity expansion", () => {
    const first = tool("first");
    const second = tool("second");
    let state = {};
    expect(isActivityExpanded(state, first)).toBe(false);
    state = toggleActivityExpansion(state, first);
    expect(isActivityExpanded(state, first)).toBe(true);
    expect(isActivityExpanded(state, second)).toBe(false);
    state = toggleActivityExpansion(state, second);
    expect(isActivityExpanded(state, first)).toBe(true);
    expect(isActivityExpanded(state, second)).toBe(true);
  });

  it("keeps processing activity separate from the final response", () => {
    const timeline: TimelineItem[] = [
      { type: "user", id: "user-1", text: "Analyze" },
      assistant("preamble", "I will inspect."),
      tool("tool-1"),
      { type: "finalResponse", id: "final", text: "# Final answer" },
    ];
    const view = buildConversationView(timeline, "completed");
    const turn = view[0];
    expect(turn?.type).toBe("turn");
    if (turn?.type !== "turn") {
      throw new Error("Expected a turn view model.");
    }
    expect(turn.activities.map((item) => item.id)).toEqual([
      "preamble",
      "tool-1",
    ]);
    expect(turn.finalResponse?.text).toBe("# Final answer");
    expect(turn.finalResponse?.text).not.toContain("README.md");
  });
});

function tool(id: string, detail = "README.md"): ToolTimelineItem {
  return {
    type: "tool",
    id,
    kind: "read",
    title: "Read",
    detail,
    state: "succeeded",
  };
}

function assistant(id: string, text: string): AssistantTimelineItem {
  return { type: "assistant", id, text, complete: true };
}
