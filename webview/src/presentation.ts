import type {
  AssistantTimelineItem,
  ErrorTimelineItem,
  ExecutionStatus,
  FinalResponseTimelineItem,
  ThinkingTimelineItem,
  TimelineItem,
  TurnUsageTimelineItem,
  ToolTimelineItem,
  UserTimelineItem,
} from "../../src/webview/messages.js";

export type ProcessingActivity =
  | AssistantTimelineItem
  | ThinkingTimelineItem
  | ToolTimelineItem;
export type ProcessingStatus =
  | "working"
  | "waiting"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTurnViewModel {
  readonly type: "turn";
  readonly id: string;
  readonly user: UserTimelineItem;
  readonly activities: readonly ProcessingActivity[];
  readonly finalResponse?: FinalResponseTimelineItem;
  readonly turnUsage?: TurnUsageTimelineItem;
  readonly errors: readonly ErrorTimelineItem[];
  readonly status: ProcessingStatus;
}

export interface StandaloneTimelineViewModel {
  readonly type: "standalone";
  readonly id: string;
  readonly item: Exclude<TimelineItem, UserTimelineItem>;
}

export type ConversationViewModel =
  | AgentTurnViewModel
  | StandaloneTimelineViewModel;

interface MutableTurn {
  readonly type: "turn";
  readonly id: string;
  readonly user: UserTimelineItem;
  readonly activities: ProcessingActivity[];
  finalResponse?: FinalResponseTimelineItem;
  turnUsage?: TurnUsageTimelineItem;
  readonly errors: ErrorTimelineItem[];
}

export interface ProcessingExpansionState {
  readonly expanded: boolean;
  readonly preference: "automatic" | "user-expanded" | "user-collapsed";
}

export interface ProcessingActivityNode {
  readonly item: ProcessingActivity;
  readonly children: readonly ProcessingActivityNode[];
}

export type ActivityExpansionState = Readonly<Record<string, boolean>>;

export function buildConversationView(
  timeline: readonly TimelineItem[],
  executionStatus: ExecutionStatus,
): readonly ConversationViewModel[] {
  const entries: (MutableTurn | StandaloneTimelineViewModel)[] = [];
  let currentTurn: MutableTurn | undefined;

  for (const item of timeline) {
    if (item.type === "user") {
      currentTurn = {
        type: "turn",
        id: item.id,
        user: item,
        activities: [],
        errors: [],
      };
      entries.push(currentTurn);
      continue;
    }
    if (item.type === "commandResult") {
      currentTurn = undefined;
      entries.push({ type: "standalone", id: item.id, item });
      continue;
    }
    if (currentTurn === undefined) {
      entries.push({ type: "standalone", id: item.id, item });
      continue;
    }
    if (item.type === "assistant" && item.complete && item.text.length === 0) {
      continue;
    }
    if (
      item.type === "assistant" ||
      item.type === "thinking" ||
      item.type === "tool"
    ) {
      currentTurn.activities.push(item);
    } else if (item.type === "finalResponse") {
      currentTurn.finalResponse = item;
    } else if (item.type === "turnUsage") {
      currentTurn.turnUsage = item;
    } else {
      currentTurn.errors.push(item);
    }
  }

  const lastTurnIndex = findLastTurnIndex(entries);
  return entries.map((entry, index) =>
    entry.type === "standalone"
      ? entry
      : {
          ...entry,
          status:
            index === lastTurnIndex
              ? processingStatus(executionStatus, entry)
              : inferredTerminalStatus(entry),
        },
  );
}

export function processingSummary(
  activities: readonly ProcessingActivity[],
  status: ProcessingStatus,
): string {
  const toolCount = activities.filter((item) => item.type === "tool").length;
  const stepCount = toolCount > 0 ? toolCount : activities.length;
  return `${String(stepCount)} ${stepCount === 1 ? "step" : "steps"} · ${processingStatusLabel(status)}`;
}

export function activitySummary(
  item: ProcessingActivity,
  workspacePath: string | undefined,
): string | undefined {
  if (item.type === "assistant") {
    return truncate(item.text.replace(/\s+/gu, " ").trim(), 90);
  }
  if (item.type === "thinking") {
    return truncate(item.text.replace(/\s+/gu, " ").trim(), 90);
  }
  if (item.detail === undefined) {
    return undefined;
  }
  if (item.kind === "read" || item.kind === "edit" || item.title === "List") {
    return shortenWorkspacePath(item.detail, workspacePath);
  }
  return truncate(item.detail.replace(/\s+/gu, " ").trim(), 100);
}

export function shortenWorkspacePath(
  value: string,
  workspacePath: string | undefined,
): string {
  const normalizedValue = value.replaceAll("\\", "/");
  if (workspacePath === undefined || workspacePath.length === 0) {
    return normalizedValue;
  }
  const normalizedWorkspace = workspacePath
    .replaceAll("\\", "/")
    .replace(/\/$/u, "");
  const caseInsensitive = /^[a-z]:\//iu.test(normalizedWorkspace);
  const comparableValue = caseInsensitive
    ? normalizedValue.toLowerCase()
    : normalizedValue;
  const comparableWorkspace = caseInsensitive
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace;
  if (comparableValue === comparableWorkspace) {
    return ".";
  }
  const prefix = `${comparableWorkspace}/`;
  return comparableValue.startsWith(prefix)
    ? normalizedValue.slice(normalizedWorkspace.length + 1)
    : normalizedValue;
}

export function initialProcessingExpansion(
  status: ProcessingStatus,
): ProcessingExpansionState {
  return {
    expanded: status !== "completed" && status !== "cancelled",
    preference: "automatic",
  };
}

export function updateProcessingExpansion(
  state: ProcessingExpansionState,
  status: ProcessingStatus,
): ProcessingExpansionState {
  if (state.preference !== "automatic") {
    return state;
  }
  if (status === "failed" || status === "waiting") {
    return state.expanded ? state : { ...state, expanded: true };
  }
  if (status === "completed" || status === "cancelled") {
    return state.expanded ? { ...state, expanded: false } : state;
  }
  return state;
}

export function setProcessingExpanded(
  _state: ProcessingExpansionState,
  expanded: boolean,
): ProcessingExpansionState {
  return {
    expanded,
    preference: expanded ? "user-expanded" : "user-collapsed",
  };
}

export function isActivityExpanded(
  state: ActivityExpansionState,
  item: ProcessingActivity,
): boolean {
  return (
    state[item.id] ??
    (item.type === "tool" ? item.state === "running" : !item.complete)
  );
}

export function buildActivityTree(
  activities: readonly ProcessingActivity[],
): readonly ProcessingActivityNode[] {
  const nodes = new Map<
    string,
    { item: ProcessingActivity; children: ProcessingActivityNode[] }
  >();
  for (const item of activities) {
    nodes.set(item.id, { item, children: [] });
  }
  const roots: ProcessingActivityNode[] = [];
  for (const item of activities) {
    const node = nodes.get(item.id);
    if (node === undefined) {
      continue;
    }
    const parentId = "parentId" in item ? item.parentId : undefined;
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

export function thoughtTitle(
  item: ThinkingTimelineItem,
  now = Date.now(),
): string {
  const durationMs = item.complete
    ? (item.durationMs ?? 0)
    : Math.max(0, now - item.startedAt);
  if (!item.complete) {
    return `∴ Thinking… ${formatDuration(durationMs)}`;
  }
  return durationMs < 1_000
    ? "∴ Thought briefly"
    : `∴ Thought for ${formatDuration(durationMs)}`;
}

function formatDuration(durationMs: number): string {
  return `${String(Math.max(1, Math.round(durationMs / 1_000)))}s`;
}

export function toggleActivityExpansion(
  state: ActivityExpansionState,
  item: ProcessingActivity,
): ActivityExpansionState {
  return { ...state, [item.id]: !isActivityExpanded(state, item) };
}

export function processingStatusLabel(status: ProcessingStatus): string {
  switch (status) {
    case "working":
      return "Working…";
    case "waiting":
      return "Permission required";
    case "cancelling":
      return "Cancelling…";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function processingStatus(
  executionStatus: ExecutionStatus,
  turn: MutableTurn,
): ProcessingStatus {
  switch (executionStatus) {
    case "running":
    case "connecting":
      return "working";
    case "waitingForPermission":
      return "waiting";
    case "cancelling":
      return "cancelling";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "idle":
    case "connected":
      return inferredTerminalStatus(turn);
  }
}

function inferredTerminalStatus(turn: MutableTurn): ProcessingStatus {
  if (turn.errors.length > 0) {
    return "failed";
  }
  return turn.finalResponse === undefined ? "cancelled" : "completed";
}

function truncate(value: string, maxLength: number): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function findLastTurnIndex(
  entries: readonly (MutableTurn | StandaloneTimelineViewModel)[],
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "turn") {
      return index;
    }
  }
  return -1;
}
