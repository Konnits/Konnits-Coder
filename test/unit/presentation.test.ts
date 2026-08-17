import { describe, expect, it } from "vitest";
import type {
  AssistantTimelineItem,
  TimelineItem,
  ToolTimelineItem,
} from "../../src/webview/messages.js";
import {
  activitySummary,
  buildActivityTree,
  buildConversationView,
  initialProcessingExpansion,
  isActivityExpanded,
  processingSummary,
  setProcessingExpanded,
  thoughtTitle,
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

  it("auto-collapses completion and never overwrites manual preferences", () => {
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
    ).toBe(false);
    expect(
      updateProcessingExpansion(
        setProcessingExpanded(running, false),
        "waiting",
      ).expanded,
    ).toBe(false);
  });

  it("defaults active thoughts open, completed thoughts closed, and preserves manual overrides", () => {
    const active = {
      type: "thinking" as const,
      id: "thought-1",
      text: "Inspecting",
      complete: false,
      startedAt: 1_000,
    };
    expect(isActivityExpanded({}, active)).toBe(true);
    const collapsed = toggleActivityExpansion({}, active);
    expect(isActivityExpanded(collapsed, { ...active, complete: true })).toBe(
      false,
    );
    const completed = { ...active, complete: true, durationMs: 3_000 };
    expect(isActivityExpanded({}, completed)).toBe(false);
    expect(
      isActivityExpanded(toggleActivityExpansion({}, completed), completed),
    ).toBe(true);
    expect(thoughtTitle(completed)).toBe("∴ Thought for 3s");
  });

  it("builds nested subagent activity from authoritative parent IDs", () => {
    const agent: ToolTimelineItem = {
      type: "tool",
      id: "agent-1",
      kind: "subagent",
      title: "Agent",
      state: "running",
    };
    const child = { ...tool("child"), parentId: "agent-1" };
    const roots = buildActivityTree([agent, child]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.item.id).toBe("agent-1");
    expect(roots[0]?.children[0]?.item.id).toBe("child");
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

  it("renders native command results as standalone Konnits entries", () => {
    const timeline: TimelineItem[] = [
      { type: "user", id: "user-1", text: "Earlier prompt" },
      { type: "finalResponse", id: "final-1", text: "Earlier answer" },
      {
        type: "commandResult",
        id: "command-1",
        command: "/help",
        title: "Available commands",
        markdown: "Local help",
        status: "success",
      },
    ];

    const view = buildConversationView(timeline, "completed");
    expect(view).toHaveLength(2);
    expect(view[1]).toMatchObject({
      type: "standalone",
      item: { type: "commandResult", command: "/help" },
    });
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
