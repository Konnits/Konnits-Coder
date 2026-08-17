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

export type ChatReferenceKind = "file" | "directory";

export interface ChatReference {
  readonly id: string;
  readonly kind: ChatReferenceKind;
  readonly workspaceFolderUri: string;
  readonly uri: string;
  readonly relativePath: string;
  readonly displayName: string;
  readonly workspaceName?: string;
}

export type SlashCommandSource =
  | "qwen"
  | "builtin"
  | "user"
  | "project"
  | "skill"
  | "mcp"
  | "extension"
  | "unknown";

export interface SlashCommandSuggestion {
  readonly name: string;
  readonly description?: string;
  readonly usage?: string;
  readonly aliases?: readonly string[];
  readonly source: SlashCommandSource;
  readonly available: boolean;
}

export interface WorkspaceReferenceSuggestion extends ChatReference {
  readonly score: number;
}

export interface UserTimelineItem {
  readonly type: "user";
  readonly id: string;
  readonly text: string;
  readonly tokenCount?: MessageTokenCount;
  readonly references?: readonly ChatReference[];
}

export interface AssistantTimelineItem {
  readonly type: "assistant";
  readonly id: string;
  readonly text: string;
  readonly complete: boolean;
  readonly cancelled?: boolean;
  readonly parentId?: string;
}

export interface ThinkingTimelineItem {
  readonly type: "thinking";
  readonly id: string;
  readonly text: string;
  readonly complete: boolean;
  readonly cancelled?: boolean;
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly parentId?: string;
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
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly output?: string;
  readonly parentId?: string;
  readonly subagentName?: string;
  readonly background?: boolean;
}

export interface TurnUsageTimelineItem {
  readonly type: "turnUsage";
  readonly id: string;
  readonly usage: TurnTokenUsage;
}

export interface ErrorTimelineItem {
  readonly type: "error";
  readonly id: string;
  readonly message: string;
}

export type TimelineItem =
  | UserTimelineItem
  | AssistantTimelineItem
  | ThinkingTimelineItem
  | FinalResponseTimelineItem
  | ToolTimelineItem
  | TurnUsageTimelineItem
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

export type ExtensionToWebviewMessage =
  | {
      readonly type: "state";
      readonly state: AppState;
    }
  | SlashCommandsMessage
  | WorkspaceReferencesMessage;

export interface SlashCommandsMessage {
  readonly type: "slashCommands";
  readonly commands: readonly SlashCommandSuggestion[];
  readonly error?: string;
}

export interface WorkspaceReferencesMessage {
  readonly type: "workspaceReferences";
  readonly requestId: string;
  readonly references: readonly WorkspaceReferenceSuggestion[];
  readonly error?: string;
}

export type WebviewToExtensionMessage =
  | { readonly type: "ready" }
  | { readonly type: "connect" }
  | {
      readonly type: "sendPrompt";
      readonly prompt: string;
      readonly references?: readonly ChatReference[];
    }
  | { readonly type: "requestSlashCommands" }
  | {
      readonly type: "searchWorkspaceReferences";
      readonly requestId: string;
      readonly query: string;
    }
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
    case "requestSlashCommands":
      return { type: value.type };
    case "sendPrompt":
      if (typeof value.prompt !== "string") {
        return undefined;
      }
      if (value.references === undefined) {
        return { type: "sendPrompt", prompt: value.prompt };
      }
      return Array.isArray(value.references) &&
        value.references.every(isChatReference)
        ? {
            type: "sendPrompt",
            prompt: value.prompt,
            references: value.references,
          }
        : undefined;
    case "searchWorkspaceReferences":
      return typeof value.requestId === "string" &&
        typeof value.query === "string"
        ? {
            type: "searchWorkspaceReferences",
            requestId: value.requestId,
            query: value.query,
          }
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

function isChatReference(value: unknown): value is ChatReference {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    (value.kind === "file" || value.kind === "directory") &&
    typeof value.workspaceFolderUri === "string" &&
    typeof value.uri === "string" &&
    typeof value.relativePath === "string" &&
    typeof value.displayName === "string" &&
    (value.workspaceName === undefined ||
      typeof value.workspaceName === "string")
  );
}
