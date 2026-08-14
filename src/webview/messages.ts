import type { AgentActivityKind } from "../agent/AgentEvent.js";
import type {
  ContextTokenUsage,
  MessageTokenCount,
  TurnTokenUsage,
} from "../agent/TokenUsage.js";
import type { FileChangeStatus } from "../changes/ProposedFileChange.js";
import type { PermissionRisk } from "../permissions/toolRisk.js";
import type { ModelSelectorViewState } from "../models/ModelTypes.js";

export type ExecutionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "running"
  | "waitingForPermission"
  | "cancelling"
  | "failed"
  | "completed";

export interface UserTimelineItem {
  readonly type: "user";
  readonly id: string;
  readonly text: string;
  readonly tokenCount?: MessageTokenCount;
}

export interface AssistantTimelineItem {
  readonly type: "assistant";
  readonly id: string;
  readonly text: string;
  readonly complete: boolean;
}

export interface FinalResponseTimelineItem {
  readonly type: "finalResponse";
  readonly id: string;
  readonly text: string;
  readonly tokenCount?: MessageTokenCount;
  readonly turnUsage?: TurnTokenUsage;
}

export interface ToolTimelineItem {
  readonly type: "tool";
  readonly id: string;
  readonly kind: AgentActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly output?: string;
}

export interface ErrorTimelineItem {
  readonly type: "error";
  readonly id: string;
  readonly message: string;
}

export type TimelineItem =
  | UserTimelineItem
  | AssistantTimelineItem
  | FinalResponseTimelineItem
  | ToolTimelineItem
  | ErrorTimelineItem;

export interface ChangeViewModel {
  readonly id: string;
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly conflictReason?: string;
}

export interface PermissionViewModel {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly risk: PermissionRisk;
  readonly detail?: string;
}

export interface AppState {
  readonly status: ExecutionStatus;
  readonly trusted: boolean;
  readonly sessionId?: string;
  readonly workspacePath?: string;
  readonly contextUsage?: ContextTokenUsage;
  readonly model: ModelSelectorViewState;
  readonly timeline: readonly TimelineItem[];
  readonly changes: readonly ChangeViewModel[];
  readonly permissions: readonly PermissionViewModel[];
}

export interface ExtensionToWebviewMessage {
  readonly type: "state";
  readonly state: AppState;
}

export type WebviewToExtensionMessage =
  | { readonly type: "ready" }
  | { readonly type: "connect" }
  | { readonly type: "sendPrompt"; readonly prompt: string }
  | { readonly type: "cancel" }
  | { readonly type: "newSession" }
  | { readonly type: "manageModels" }
  | { readonly type: "addModel" }
  | { readonly type: "openModelSettings" }
  | { readonly type: "reviewFile"; readonly id: string }
  | { readonly type: "acceptFile"; readonly id: string }
  | { readonly type: "rejectFile"; readonly id: string }
  | { readonly type: "acceptAll" }
  | { readonly type: "rejectAll" }
  | { readonly type: "openExternal"; readonly href: string }
  | {
      readonly type: "resolvePermission";
      readonly id: string;
      readonly decision: "allow" | "deny";
    };

export function parseWebviewMessage(
  value: unknown,
): WebviewToExtensionMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  switch (value.type) {
    case "ready":
    case "connect":
    case "cancel":
    case "newSession":
    case "manageModels":
    case "addModel":
    case "openModelSettings":
    case "acceptAll":
    case "rejectAll":
      return { type: value.type };
    case "sendPrompt":
      return typeof value.prompt === "string"
        ? { type: "sendPrompt", prompt: value.prompt }
        : undefined;
    case "reviewFile":
    case "acceptFile":
    case "rejectFile":
      return typeof value.id === "string"
        ? { type: value.type, id: value.id }
        : undefined;
    case "openExternal":
      return typeof value.href === "string"
        ? { type: "openExternal", href: value.href }
        : undefined;
    case "resolvePermission":
      return typeof value.id === "string" &&
        (value.decision === "allow" || value.decision === "deny")
        ? { type: "resolvePermission", id: value.id, decision: value.decision }
        : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
