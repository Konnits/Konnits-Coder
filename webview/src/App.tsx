import { useEffect, useMemo, useState } from "react";
import type {
  AppState,
  ChangeViewModel,
  ExtensionToWebviewMessage,
} from "../../src/webview/messages.js";
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

const initialState: AppState = {
  status: "idle",
  trusted: true,
  model: { label: "Loading model…", configuredCount: 0 },
  timeline: [],
  changes: [],
  permissions: [],
};

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>(initialState);
  const [prompt, setPrompt] = useState("");
  const busy = useMemo(
    () =>
      state.status === "connecting" ||
      state.status === "running" ||
      state.status === "waitingForPermission" ||
      state.status === "cancelling",
    [state.status],
  );
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
          if (item.type === "finalResponse" || item.type === "user") {
            return `${item.type}:${item.id}:${String(item.text.length)}`;
          }
          if (item.type === "tool") {
            return `${item.type}:${item.id}:${item.state}`;
          }
          if (item.type === "turnUsage") {
            return `${item.type}:${item.id}:${String(item.usage.totalTokens)}`;
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
  const { contentRef, following, jumpToLatest } = useStickyBottom(
    `${timelineScrollKey}|${permissionScrollKey}|${state.status}|${String(state.changes.length)}`,
  );

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>): void => {
      if (isStateMessage(event.data)) {
        setState(event.data.state);
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const conversation = useMemo(
    () => buildConversationView(state.timeline, state.status),
    [state.status, state.timeline],
  );
  const openLink = (href: string): void =>
    vscode.postMessage({ type: "openExternal", href });

  const send = (): void => {
    const value = prompt.trim();
    if (value.length === 0 || busy || !state.trusted) {
      return;
    }
    vscode.postMessage({ type: "sendPrompt", prompt: value });
    setPrompt("");
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

      <div className="chat-body" ref={contentRef}>
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

        {state.changes.length > 0 && <ChangedFiles changes={state.changes} />}

        {!following && (
          <button
            className="jump-latest"
            type="button"
            aria-label="Jump to latest message"
            title="Jump to latest"
            onClick={jumpToLatest}
          >
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 1.5v6m0 0L3.25 4.75M6 7.5l2.75-2.75" />
            </svg>
          </button>
        )}
      </div>

      <footer className="composer">
        <textarea
          value={prompt}
          disabled={busy || !state.trusted}
          rows={3}
          aria-label="Message Qwen"
          placeholder={
            state.trusted
              ? "Ask Qwen to work on this workspace…"
              : "Trust workspace to chat"
          }
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <button
              className="danger"
              disabled={state.status === "cancelling"}
              onClick={() => vscode.postMessage({ type: "cancel" })}
            >
              {state.status === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
          ) : (
            <button
              className="primary"
              disabled={prompt.trim().length === 0 || !state.trusted}
              onClick={send}
            >
              Send
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}

function isStateMessage(value: unknown): value is ExtensionToWebviewMessage {
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
    "model" in state &&
    typeof state.model === "object" &&
    state.model !== null &&
    "timeline" in state &&
    Array.isArray(state.timeline) &&
    "changes" in state &&
    Array.isArray(state.changes) &&
    "permissions" in state &&
    Array.isArray(state.permissions)
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
    case "thinking":
    case "turnUsage":
      return null;
  }
}

function ChangedFiles({
  changes,
}: {
  readonly changes: readonly ChangeViewModel[];
}): React.JSX.Element {
  const pending = changes.filter((change) => change.status === "pending");
  return (
    <section className="changes" aria-label="Changed files">
      <div className="section-heading">
        <h2>Changed files</h2>
        <span>{pending.length} pending</span>
      </div>
      <div className="change-list">
        {changes.map((change) => (
          <article className={`change change-${change.status}`} key={change.id}>
            <button
              className="file-link"
              title={`Review ${change.path}`}
              onClick={() =>
                vscode.postMessage({ type: "reviewFile", id: change.id })
              }
            >
              <span className="file-status">{fileStatus(change.status)}</span>
              <span className="file-path">{change.path}</span>
              <span className="diff-stat">
                <span className="additions">+{change.additions}</span>{" "}
                <span className="deletions">-{change.deletions}</span>
              </span>
            </button>
            {change.conflictReason !== undefined && (
              <p className="conflict-reason">{change.conflictReason}</p>
            )}
            {change.status === "pending" && (
              <div className="file-actions">
                <button
                  onClick={() =>
                    vscode.postMessage({ type: "acceptFile", id: change.id })
                  }
                >
                  Accept
                </button>
                <button
                  onClick={() =>
                    vscode.postMessage({ type: "rejectFile", id: change.id })
                  }
                >
                  Reject
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {pending.length > 0 && (
        <div className="button-row bulk-actions">
          <button
            className="primary"
            onClick={() => vscode.postMessage({ type: "acceptAll" })}
          >
            Accept all
          </button>
          <button onClick={() => vscode.postMessage({ type: "rejectAll" })}>
            Reject all
          </button>
        </div>
      )}
    </section>
  );
}

function statusLabel(status: AppState["status"]): string {
  const labels: Record<AppState["status"], string> = {
    idle: "Idle",
    connecting: "Connecting",
    connected: "Connected",
    running: "Qwen is working",
    waitingForPermission: "Waiting for permission",
    cancelling: "Cancelling",
    failed: "Failed",
    completed: "Completed",
  };
  return labels[status];
}

function fileStatus(status: ChangeViewModel["status"]): string {
  switch (status) {
    case "pending":
      return "M";
    case "accepted":
      return "✓";
    case "rejected":
      return "↶";
    case "conflicted":
      return "!";
  }
}
