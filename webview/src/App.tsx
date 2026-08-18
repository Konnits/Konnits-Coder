import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppState,
  ExtensionToWebviewMessage,
  ChatReference,
  TimelineItem,
  SlashCommandSuggestion,
  WorkspaceReferenceSuggestion,
} from "../../src/webview/messages.js";
import {
  parseComposerSuggestionMode,
  replaceComposerSuggestion,
  type ComposerSuggestionMode,
} from "../../src/chat/ComposerInputParser.js";
import { AgentTurn } from "./AgentTurn.js";
import { ContextUsageMeter } from "./ContextUsageMeter.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { TokenCount } from "./TokenCount.js";
import {
  buildConversationView,
  type StandaloneTimelineViewModel,
} from "./presentation.js";
import { vscode } from "./vscode.js";
import { useStickyBottom } from "./stickyBottom.js";
import { PermissionCard } from "./PermissionCard.js";
import { SuggestionPopup } from "./SuggestionPopup.js";
import { ChatScrollRegion } from "./ChatScrollRegion.js";
import { ChangedFilesPanel, TodosPanel } from "./WorkSummaryPanels.js";
import {
  moveSuggestionHighlight,
  resizeComposerTextarea,
} from "./composerLayout.js";
import { encodeClipboardImage } from "./clipboardAttachment.js";

const SUGGESTION_LISTBOX_ID = "composer-suggestions";

const initialState: AppState = {
  status: "idle",
  trusted: true,
  permissionMode: "default",
  model: { label: "Loading model…", configuredCount: 0 },
  timeline: [],
  todos: [],
  changes: [],
  permissions: [],
};

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>(initialState);
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const [commands, setCommands] = useState<readonly SlashCommandSuggestion[]>(
    [],
  );
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [referenceResults, setReferenceResults] = useState<
    readonly WorkspaceReferenceSuggestion[]
  >([]);
  const [selectedReferences, setSelectedReferences] = useState<
    readonly ChatReference[]
  >([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<
    string | undefined
  >();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [editingPromptId, setEditingPromptId] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(0);
  const attachmentRequestId = useRef(0);
  const pendingAttachmentRequests = useRef(new Set<string>());
  const busy = useMemo(
    () =>
      state.status === "connecting" ||
      state.status === "running" ||
      state.status === "waitingForPermission" ||
      state.status === "cancelling" ||
      state.status === "restoring",
    [state.status],
  );
  const canSendFollowUp = state.status === "running";
  const composerDisabled = !state.trusted || (busy && !canSendFollowUp);
  const timelineScrollKey = useMemo(
    () =>
      state.timeline
        .map((item) => {
          if (item.type === "assistant") {
            return `${item.type}:${item.id}:${String(item.text.length)}:${String(item.complete)}:${String(item.cancelled)}`;
          }
          if (item.type === "thinking") {
            return `${item.type}:${item.id}:${String(item.text.length)}:${String(item.complete)}:${String(item.cancelled)}`;
          }
          if (
            item.type === "finalResponse" ||
            item.type === "user" ||
            item.type === "followUp"
          ) {
            return `${item.type}:${item.id}:${String(item.text.length)}`;
          }
          if (item.type === "tool") {
            return `${item.type}:${item.id}:${item.state}`;
          }
          if (item.type === "turnUsage") {
            return `${item.type}:${item.id}:${String(item.usage.totalTokens)}`;
          }
          if (item.type === "commandResult") {
            return `${item.type}:${item.id}:${item.status}:${String(item.markdown.length)}`;
          }
          return `${item.type}:${item.id}:${String(item.message.length)}`;
        })
        .join("|"),
    [state.timeline],
  );
  const permissionScrollKey = useMemo(
    () => state.permissions.map((permission) => permission.id).join("|"),
    [state.permissions],
  );
  const todoScrollKey = useMemo(
    () =>
      state.todos
        .map((todo) => `${todo.id}:${todo.status}:${todo.content}`)
        .join("|"),
    [state.todos],
  );
  const { contentRef, following, jumpToLatest } = useStickyBottom(
    `${timelineScrollKey}|${permissionScrollKey}|${todoScrollKey}|${state.status}|${String(state.changes.length)}`,
    state.sessionId ?? "no-session",
  );

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>): void => {
      if (isStateMessage(event.data)) {
        setState(event.data.state);
      } else if (isSlashCommandsMessage(event.data)) {
        setCommands(event.data.commands);
        setCommandsLoaded(true);
      } else if (isWorkspaceReferencesMessage(event.data)) {
        if (event.data.requestId === String(requestId.current)) {
          setReferenceResults(event.data.references);
        }
      } else if (isAttachmentSelectionMessage(event.data)) {
        if (!pendingAttachmentRequests.current.delete(event.data.requestId)) {
          return;
        }
        setAttachmentError(event.data.error);
        const attachments = event.data.attachments;
        if (attachments.length > 0) {
          setSelectedReferences((current) =>
            mergeReferences(current, attachments),
          );
        }
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea !== null) {
      resizeComposerTextarea(textarea);
    }
  }, [prompt]);

  const suggestionMode = useMemo(
    () => parseComposerSuggestionMode(prompt, cursor),
    [cursor, prompt],
  );
  const suggestionKey = useMemo(
    () => createSuggestionKey(suggestionMode),
    [suggestionMode],
  );
  const visibleCommands = useMemo(() => {
    if (suggestionMode.kind !== "command") {
      return [];
    }
    const query = suggestionMode.query.toLowerCase();
    return commands.filter((command) =>
      [command.command, ...(command.aliases ?? [])].some(
        (name) =>
          name.toLowerCase().includes(query) ||
          name.toLowerCase().includes(`/${query}`),
      ),
    );
  }, [commands, suggestionMode]);
  const visibleSuggestions =
    suggestionMode.kind === "command" ? visibleCommands : referenceResults;
  const suggestionsOpen =
    suggestionMode.kind !== "none" &&
    suggestionKey !== dismissedSuggestionKey &&
    visibleSuggestions.length > 0;

  useEffect(() => {
    setHighlightedIndex(0);
    if (suggestionMode.kind === "command" && !commandsLoaded) {
      vscode.postMessage({ type: "requestSlashCommands" });
    }
  }, [commandsLoaded, suggestionKey, suggestionMode.kind]);

  useEffect(() => {
    setHighlightedIndex((index) =>
      visibleSuggestions.length === 0
        ? 0
        : Math.min(index, visibleSuggestions.length - 1),
    );
  }, [visibleSuggestions.length]);

  useEffect(() => {
    if (suggestionMode.kind !== "reference") {
      return;
    }
    const currentRequestId = String(requestId.current + 1);
    requestId.current += 1;
    const timer = window.setTimeout(() => {
      vscode.postMessage({
        type: "searchWorkspaceReferences",
        requestId: currentRequestId,
        query: suggestionMode.query,
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [suggestionMode]);

  const conversation = useMemo(
    () => buildConversationView(state.timeline, state.status),
    [state.status, state.timeline],
  );
  const openLink = (href: string): void =>
    vscode.postMessage({ type: "openExternal", href });

  const send = (): void => {
    const value = prompt.trim();
    if (
      (value.length === 0 && selectedReferences.length === 0) ||
      (busy && !canSendFollowUp) ||
      !state.trusted
    ) {
      return;
    }
    vscode.postMessage(
      editingPromptId === undefined
        ? {
            type: "sendPrompt",
            prompt: value,
            ...(selectedReferences.length === 0
              ? {}
              : { references: selectedReferences }),
          }
        : {
            type: "editPrompt",
            id: editingPromptId,
            prompt: value,
            ...(selectedReferences.length === 0
              ? {}
              : { references: selectedReferences }),
          },
    );
    setPrompt("");
    setCursor(0);
    setSelectedReferences([]);
    setAttachmentError(undefined);
    setEditingPromptId(undefined);
  };

  const editPrompt = (user: Extract<TimelineItem, { type: "user" }>): void => {
    setEditingPromptId(user.id);
    setPrompt(user.text);
    setCursor(user.text.length);
    setSelectedReferences(user.references ?? []);
    setAttachmentError(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        user.text.length,
        user.text.length,
      );
    });
  };

  const cancelPromptEdit = (): void => {
    setEditingPromptId(undefined);
    setPrompt("");
    setCursor(0);
    setSelectedReferences([]);
    setAttachmentError(undefined);
  };

  const requestAttachments = (): void => {
    if (busy || !state.trusted) {
      return;
    }
    const id = createAttachmentRequestId(attachmentRequestId);
    pendingAttachmentRequests.current.add(id);
    setAttachmentError(undefined);
    vscode.postMessage({ type: "pickAttachments", requestId: id });
  };

  const pasteImage = async (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> => {
    const image = findClipboardImage(event.clipboardData.files);
    if (image === undefined) {
      return;
    }
    event.preventDefault();
    if (busy || !state.trusted) {
      setAttachmentError(
        "Images can be attached before starting a Qwen operation.",
      );
      return;
    }
    const id = createAttachmentRequestId(attachmentRequestId);
    pendingAttachmentRequests.current.add(id);
    setAttachmentError(undefined);
    try {
      const encoded = await encodeClipboardImage(image);
      vscode.postMessage({
        type: "saveClipboardImage",
        requestId: id,
        ...encoded,
      });
    } catch (error) {
      pendingAttachmentRequests.current.delete(id);
      setAttachmentError(
        error instanceof Error ? error.message : "Unable to attach the image.",
      );
    }
  };

  const updatePrompt = (
    value: string,
    nextCursor: number,
    dismissSuggestions = false,
  ): void => {
    setPrompt(value);
    setCursor(nextCursor);
    setDismissedSuggestionKey(
      dismissSuggestions
        ? createSuggestionKey(parseComposerSuggestionMode(value, nextCursor))
        : undefined,
    );
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const selectCommand = (command: SlashCommandSuggestion): void => {
    if (suggestionMode.kind !== "command") {
      return;
    }
    const replacement = command.command;
    updatePrompt(
      replaceComposerSuggestion(prompt, suggestionMode, replacement),
      suggestionMode.start + replacement.length,
      true,
    );
  };

  const selectReference = (reference: WorkspaceReferenceSuggestion): void => {
    if (suggestionMode.kind !== "reference") {
      return;
    }
    if (!selectedReferences.some((selected) => selected.id === reference.id)) {
      setSelectedReferences((current) => [...current, reference]);
    }
    updatePrompt(
      replaceComposerSuggestion(prompt, suggestionMode, ""),
      suggestionMode.start,
    );
  };

  const onComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (suggestionsOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((index) =>
          moveSuggestionHighlight(index, 1, visibleSuggestions.length),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((index) =>
          moveSuggestionHighlight(index, -1, visibleSuggestions.length),
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSuggestionKey(suggestionKey);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = visibleSuggestions[highlightedIndex];
        if (selected !== undefined) {
          if (suggestionMode.kind === "command") {
            selectCommand(selected as SlashCommandSuggestion);
          } else {
            selectReference(selected as WorkspaceReferenceSuggestion);
          }
        }
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <main className="app">
      <div className="connection-header">
        <header className="status-bar">
          <span
            className={`status-dot status-${state.status}`}
            aria-hidden="true"
          />
          <span>{statusLabel(state.status)}</span>
          <button
            className="model-selector"
            disabled={busy}
            title={
              busy
                ? "Cancel the active Qwen operation before changing models"
                : `${state.model.label}${state.model.description === undefined ? "" : ` — ${state.model.description}`}`
            }
            aria-label={`Current model: ${state.model.label}. Select or manage models.`}
            onClick={() => vscode.postMessage({ type: "manageModels" })}
          >
            <span className="model-label">{state.model.label}</span>
            <span className="model-chevron" aria-hidden="true" />
          </button>
          {state.sessionId !== undefined && (
            <span className="session" title={state.sessionId}>
              Session {state.sessionId.slice(0, 8)}
            </span>
          )}
        </header>
        {state.contextUsage !== undefined && (
          <ContextUsageMeter usage={state.contextUsage} />
        )}
      </div>

      <ChatScrollRegion
        contentRef={contentRef}
        following={following}
        onJumpToLatest={jumpToLatest}
        bottomDock={
          state.todos.length > 0 || state.changes.length > 0 ? (
            <aside className="work-summary-panels" aria-label="Work summary">
              {state.todos.length > 0 && <TodosPanel todos={state.todos} />}
              {state.changes.length > 0 && (
                <ChangedFilesPanel changes={state.changes} />
              )}
            </aside>
          ) : undefined
        }
      >
        {!state.trusted && (
          <section className="notice" role="alert">
            Qwen execution is disabled in Restricted Mode. Trust this workspace
            to use the agent.
          </section>
        )}

        {state.model.warning !== undefined && (
          <section className="notice model-notice" role="status">
            {state.model.warning}
          </section>
        )}

        {state.model.error !== undefined && (
          <section className="error-message model-notice" role="alert">
            <strong>Model settings</strong>
            <p>{state.model.error}</p>
          </section>
        )}

        <section className="timeline" aria-label="Conversation">
          {state.timeline.length === 0 ? <EmptyState /> : null}
          {conversation.map((entry) =>
            entry.type === "turn" ? (
              <AgentTurn
                key={entry.id}
                turn={entry}
                workspacePath={state.workspacePath}
                onOpenLink={openLink}
                canRetry={!busy && state.trusted}
                onRetry={(id) =>
                  vscode.postMessage({ type: "retryPrompt", id })
                }
                onEdit={editPrompt}
                onRestoreFiles={(id) =>
                  vscode.postMessage({ type: "restorePromptFiles", id })
                }
              />
            ) : (
              <StandaloneEntry
                key={entry.id}
                entry={entry}
                onOpenLink={openLink}
              />
            ),
          )}
          {state.permissions.map((permission) => (
            <PermissionCard
              key={permission.id}
              permission={permission}
              onDecision={(decision) =>
                vscode.postMessage({
                  type: "resolvePermission",
                  id: permission.id,
                  decision,
                })
              }
            />
          ))}
        </section>
      </ChatScrollRegion>

      <footer className="composer">
        {editingPromptId !== undefined && (
          <div className="composer-editing" role="status">
            <span>
              Editing: later turns and tracked file changes will be removed
            </span>
            <button type="button" onClick={cancelPromptEdit}>
              Cancel
            </button>
          </div>
        )}
        {selectedReferences.length > 0 && (
          <div className="reference-chips" aria-label="Selected references">
            {selectedReferences.map((reference) => (
              <span className="reference-chip" key={reference.id}>
                <span aria-hidden="true">
                  {reference.source === "attachment" ? "📎" : "@"}
                </span>
                <span>{reference.displayName}</span>
                <button
                  type="button"
                  aria-label={`Remove ${reference.displayName}`}
                  onClick={() =>
                    setSelectedReferences((current) =>
                      current.filter((item) => item.id !== reference.id),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError !== undefined && (
          <div className="composer-error" role="alert">
            {attachmentError}
          </div>
        )}
        <div className="composer-input">
          {suggestionsOpen && (
            <SuggestionPopup
              id={SUGGESTION_LISTBOX_ID}
              kind={
                suggestionMode.kind === "reference" ? "reference" : "command"
              }
              commands={visibleCommands}
              references={referenceResults}
              highlightedIndex={highlightedIndex}
              onHighlight={setHighlightedIndex}
              onSelectCommand={selectCommand}
              onSelectReference={selectReference}
            />
          )}
          <textarea
            ref={textareaRef}
            value={prompt}
            disabled={composerDisabled}
            rows={1}
            aria-label="Message Qwen"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen}
            {...(suggestionsOpen
              ? {
                  "aria-controls": SUGGESTION_LISTBOX_ID,
                  "aria-activedescendant": `${SUGGESTION_LISTBOX_ID}-option-${String(highlightedIndex)}`,
                }
              : {})}
            placeholder={
              state.trusted
                ? canSendFollowUp
                  ? "Send an update to Qwen…"
                  : "Ask Qwen to work on this workspace…"
                : "Trust workspace to chat"
            }
            onChange={(event) => {
              setPrompt(event.target.value);
              setCursor(event.target.selectionStart);
              setDismissedSuggestionKey(undefined);
            }}
            onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
            onClick={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={onComposerKeyDown}
            onPaste={(event) => void pasteImage(event)}
          />
        </div>
        <div className="composer-actions">
          <div className="composer-tools">
            <button
              type="button"
              className="icon-button"
              disabled={busy || !state.trusted}
              title="Attach files or paste an image"
              aria-label="Attach files"
              onClick={requestAttachments}
            >
              <AttachmentIcon />
            </button>
            <button
              type="button"
              className={`icon-button permission-mode-${state.permissionMode}`}
              title={permissionModeTitle(state.permissionMode)}
              aria-label={`Manage agent permissions. ${permissionModeTitle(state.permissionMode)}`}
              onClick={() =>
                vscode.postMessage({ type: "openPermissionSettings" })
              }
            >
              <PermissionsIcon />
            </button>
          </div>
          <div className="composer-submit">
            {busy && state.status !== "restoring" && (
              <button
                className="danger"
                disabled={state.status === "cancelling"}
                onClick={() => vscode.postMessage({ type: "cancel" })}
              >
                {state.status === "cancelling" ? "Cancelling…" : "Cancel"}
              </button>
            )}
            <button
              className="primary"
              disabled={
                (prompt.trim().length === 0 &&
                  selectedReferences.length === 0) ||
                composerDisabled
              }
              onClick={send}
            >
              {editingPromptId !== undefined
                ? "Save edit"
                : canSendFollowUp
                  ? "Send update"
                  : "Send"}
            </button>
          </div>
        </div>
      </footer>
    </main>
  );
}

function isStateMessage(
  value: unknown,
): value is Extract<ExtensionToWebviewMessage, { readonly type: "state" }> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    !("state" in value)
  ) {
    return false;
  }
  const state = value.state;
  return (
    value.type === "state" &&
    typeof state === "object" &&
    state !== null &&
    "status" in state &&
    typeof state.status === "string" &&
    "trusted" in state &&
    typeof state.trusted === "boolean" &&
    "permissionMode" in state &&
    (state.permissionMode === "default" ||
      state.permissionMode === "plan" ||
      state.permissionMode === "yolo") &&
    "model" in state &&
    typeof state.model === "object" &&
    state.model !== null &&
    "timeline" in state &&
    Array.isArray(state.timeline) &&
    "todos" in state &&
    Array.isArray(state.todos) &&
    "changes" in state &&
    Array.isArray(state.changes) &&
    "permissions" in state &&
    Array.isArray(state.permissions)
  );
}

function permissionModeTitle(mode: AppState["permissionMode"]): string {
  switch (mode) {
    case "default":
      return "Permissions: ask before sensitive actions";
    case "plan":
      return "Permissions: plan only";
    case "yolo":
      return "Permissions: full access — no approval prompts";
  }
}

function isSlashCommandsMessage(
  value: unknown,
): value is Extract<
  ExtensionToWebviewMessage,
  { readonly type: "slashCommands" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "slashCommands" &&
    "commands" in value &&
    Array.isArray(value.commands)
  );
}

function isWorkspaceReferencesMessage(
  value: unknown,
): value is Extract<
  ExtensionToWebviewMessage,
  { readonly type: "workspaceReferences" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "workspaceReferences" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "references" in value &&
    Array.isArray(value.references)
  );
}

function isAttachmentSelectionMessage(
  value: unknown,
): value is Extract<
  ExtensionToWebviewMessage,
  { readonly type: "attachmentsSelected" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "attachmentsSelected" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "attachments" in value &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isChatReference) &&
    (!("error" in value) ||
      value.error === undefined ||
      typeof value.error === "string")
  );
}

function isChatReference(value: unknown): value is ChatReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "kind" in value &&
    (value.kind === "file" || value.kind === "directory") &&
    "workspaceFolderUri" in value &&
    typeof value.workspaceFolderUri === "string" &&
    "uri" in value &&
    typeof value.uri === "string" &&
    "relativePath" in value &&
    typeof value.relativePath === "string" &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    (!("workspaceName" in value) ||
      value.workspaceName === undefined ||
      typeof value.workspaceName === "string") &&
    (!("source" in value) ||
      value.source === undefined ||
      value.source === "workspace" ||
      value.source === "attachment")
  );
}

function findClipboardImage(files: FileList): File | undefined {
  for (let index = 0; index < files.length; index += 1) {
    const file = files.item(index);
    if (file?.type.startsWith("image/")) {
      return file;
    }
  }
  return undefined;
}

function createAttachmentRequestId(counter: { current: number }): string {
  counter.current += 1;
  return `attachment-${String(counter.current)}`;
}

function mergeReferences(
  current: readonly ChatReference[],
  additions: readonly ChatReference[],
): readonly ChatReference[] {
  const merged = new Map(current.map((reference) => [reference.id, reference]));
  for (const reference of additions) {
    merged.set(reference.id, reference);
  }
  return [...merged.values()];
}

function AttachmentIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 8.7 9.8 4a2.1 2.1 0 0 1 3 3L7.2 12.6a3.2 3.2 0 0 1-4.5-4.5l5.5-5.5" />
    </svg>
  );
}

function PermissionsIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 13 3.4v3.8c0 3.2-2 5.8-5 7.3-3-1.5-5-4.1-5-7.3V3.4L8 1.5Z" />
      <path d="m5.8 8 1.4 1.4 3-3" />
    </svg>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="empty-state">
      <h1>Qwen Frontend</h1>
      <p>Ask Qwen Code to inspect, edit, run, and test this workspace.</p>
      <p>Agent edits stay reviewable until you accept or safely reject them.</p>
    </div>
  );
}

function StandaloneEntry({
  entry,
  onOpenLink,
}: {
  readonly entry: StandaloneTimelineViewModel;
  readonly onOpenLink: (href: string) => void;
}): React.JSX.Element | null {
  const item = entry.item;
  switch (item.type) {
    case "assistant":
      if (item.text.length === 0 && item.complete) {
        return null;
      }
      return (
        <article className="message assistant-message">
          <div className="eyebrow">Qwen</div>
          <MarkdownMessage
            source={item.text || "Thinking…"}
            onOpenLink={onOpenLink}
          />
        </article>
      );
    case "finalResponse":
      return (
        <article className="message assistant-message">
          <div className="eyebrow">Qwen</div>
          <MarkdownMessage source={item.text} onOpenLink={onOpenLink} />
          <TokenCount count={item.tokenCount} turnUsage={item.turnUsage} />
        </article>
      );
    case "tool":
      return (
        <article className={`tool tool-${item.state}`}>
          <span className="tool-icon" aria-hidden="true">
            {item.state === "running"
              ? "●"
              : item.state === "succeeded"
                ? "✓"
                : item.state === "cancelled"
                  ? "⊘"
                  : "✕"}
          </span>
          <div>
            <strong>{item.title}</strong>
            {item.detail !== undefined && <code>{item.detail}</code>}
            {item.output !== undefined && item.state === "failed" && (
              <pre>{item.output}</pre>
            )}
          </div>
        </article>
      );
    case "error":
      return (
        <article className="error-message" role="alert">
          <strong>Error</strong>
          <p>{item.message}</p>
        </article>
      );
    case "commandResult":
      return (
        <article
          className={`command-result command-result-${item.status}`}
          role={item.status === "error" ? "alert" : undefined}
        >
          <div className="eyebrow">Konnits</div>
          <code className="command-result-invocation">{item.command}</code>
          <h3>{item.title}</h3>
          <MarkdownMessage source={item.markdown} onOpenLink={onOpenLink} />
        </article>
      );
    case "followUp":
      return (
        <article className="message user-message follow-up-message">
          <div className="eyebrow">You · Update</div>
          <p>{item.text}</p>
          <TokenCount count={item.tokenCount} />
        </article>
      );
    case "thinking":
    case "turnUsage":
      return null;
  }
}

function createSuggestionKey(mode: ComposerSuggestionMode): string {
  return mode.kind === "none"
    ? "none"
    : `${mode.kind}:${String(mode.start)}:${String(mode.end)}:${mode.query}`;
}

function statusLabel(status: AppState["status"]): string {
  const labels: Record<AppState["status"], string> = {
    idle: "Idle",
    connecting: "Connecting",
    connected: "Connected",
    running: "Qwen is working",
    waitingForPermission: "Waiting for permission",
    cancelling: "Cancelling",
    restoring: "Restoring checkpoint",
    failed: "Failed",
    completed: "Completed",
  };
  return labels[status];
}
