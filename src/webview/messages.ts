import type { AgentActivityKind } from "../agent/AgentEvent.js";
import type {
  ContextTokenUsage,
  MessageTokenCount,
  TurnTokenUsage,
} from "../agent/TokenUsage.js";
import type { FileChangeStatus } from "../changes/ProposedFileChange.js";
import type { PermissionRisk } from "../permissions/toolRisk.js";
import type { ModelSelectorViewState } from "../models/ModelTypes.js";
import type { SlashCommandDescriptor } from "../commands/SlashCommand.js";
import type { AgentPermissionMode } from "../permissions/AgentPermissionMode.js";

export type ExecutionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "running"
  | "waitingForPermission"
  | "cancelling"
  | "restoring"
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
  readonly source?: "workspace" | "attachment";
}

export type SlashCommandSuggestion = SlashCommandDescriptor;

export interface WorkspaceReferenceSuggestion extends ChatReference {
  readonly score: number;
}

export interface UserTimelineItem {
  readonly type: "user";
  readonly id: string;
  readonly text: string;
  readonly tokenCount?: MessageTokenCount;
  readonly references?: readonly ChatReference[];
  readonly canEdit?: boolean;
  readonly canRestoreFiles?: boolean;
}

export interface FollowUpTimelineItem {
  readonly type: "followUp";
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

export interface CommandResultTimelineItem {
  readonly type: "commandResult";
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly markdown: string;
  readonly status: "success" | "error";
}

export type TimelineItem =
  | UserTimelineItem
  | FollowUpTimelineItem
  | AssistantTimelineItem
  | ThinkingTimelineItem
  | FinalResponseTimelineItem
  | ToolTimelineItem
  | TurnUsageTimelineItem
  | ErrorTimelineItem
  | CommandResultTimelineItem;

export interface ChangeViewModel {
  readonly id: string;
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly status: FileChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly conflictReason?: string;
}

export interface TodoViewModel {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
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
  readonly permissionMode: AgentPermissionMode;
  readonly sessionId?: string;
  readonly workspacePath?: string;
  readonly contextUsage?: ContextTokenUsage;
  readonly model: ModelSelectorViewState;
  readonly timeline: readonly TimelineItem[];
  readonly todos: readonly TodoViewModel[];
  readonly changes: readonly ChangeViewModel[];
  readonly permissions: readonly PermissionViewModel[];
}

export type ExtensionToWebviewMessage =
  | {
      readonly type: "state";
      readonly state: AppState;
    }
  | SlashCommandsMessage
  | WorkspaceReferencesMessage
  | AttachmentSelectionMessage;

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

export interface AttachmentSelectionMessage {
  readonly type: "attachmentsSelected";
  readonly requestId: string;
  readonly attachments: readonly ChatReference[];
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
  | { readonly type: "clearTodos" }
  | { readonly type: "manageModels" }
  | { readonly type: "addModel" }
  | { readonly type: "openModelSettings" }
  | { readonly type: "openPermissionSettings" }
  | { readonly type: "retryPrompt"; readonly id: string }
  | {
      readonly type: "editPrompt";
      readonly id: string;
      readonly prompt: string;
      readonly references?: readonly ChatReference[];
    }
  | { readonly type: "restorePromptFiles"; readonly id: string }
  | { readonly type: "pickAttachments"; readonly requestId: string }
  | {
      readonly type: "saveClipboardImage";
      readonly requestId: string;
      readonly name: string;
      readonly mimeType: string;
      readonly data: string;
    }
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
    case "clearTodos":
    case "manageModels":
    case "addModel":
    case "openModelSettings":
    case "openPermissionSettings":
    case "acceptAll":
    case "rejectAll":
    case "requestSlashCommands":
      return { type: value.type };
    case "retryPrompt":
    case "restorePromptFiles":
      return typeof value.id === "string"
        ? { type: value.type, id: value.id }
        : undefined;
    case "editPrompt":
      if (typeof value.id !== "string" || typeof value.prompt !== "string") {
        return undefined;
      }
      if (value.references === undefined) {
        return { type: "editPrompt", id: value.id, prompt: value.prompt };
      }
      return Array.isArray(value.references) &&
        value.references.every(isChatReference)
        ? {
            type: "editPrompt",
            id: value.id,
            prompt: value.prompt,
            references: value.references,
          }
        : undefined;
    case "pickAttachments":
      return typeof value.requestId === "string"
        ? { type: "pickAttachments", requestId: value.requestId }
        : undefined;
    case "saveClipboardImage":
      return typeof value.requestId === "string" &&
        typeof value.name === "string" &&
        typeof value.mimeType === "string" &&
        typeof value.data === "string"
        ? {
            type: "saveClipboardImage",
            requestId: value.requestId,
            name: value.name,
            mimeType: value.mimeType,
            data: value.data,
          }
        : undefined;
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
    (value.source === undefined ||
      value.source === "workspace" ||
      value.source === "attachment") &&
    (value.workspaceName === undefined ||
      typeof value.workspaceName === "string")
  );
}
