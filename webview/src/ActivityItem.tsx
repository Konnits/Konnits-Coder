import { useEffect, useRef, useState } from "react";
import { MarkdownMessage } from "./MarkdownMessage.js";
import {
  activitySummary,
  isActivityExpanded,
  thoughtTitle,
  type ActivityExpansionState,
  type ProcessingActivity,
  type ProcessingActivityNode,
} from "./presentation.js";

interface ActivityItemProps {
  readonly node: ProcessingActivityNode;
  readonly expansion: ActivityExpansionState;
  readonly workspacePath?: string;
  readonly onToggle: (item: ProcessingActivity, hasChildren: boolean) => void;
  readonly onOpenLink: (href: string) => void;
}

export function ActivityItem({
  node,
  expansion,
  workspacePath,
  onToggle,
  onOpenLink,
}: ActivityItemProps): React.JSX.Element {
  const { item } = node;
  const hasChildren = node.children.length > 0;
  const expanded = isActivityExpanded(expansion, item, hasChildren);
  const now = useCurrentTime(item.type === "thinking" && !item.complete);
  const detailsRef = useRef<HTMLDivElement>(null);
  const title =
    item.type === "followUp"
      ? "You"
      : item.type === "assistant"
        ? "Qwen"
        : item.type === "thinking"
          ? thoughtTitle(item, now)
          : item.title;
  const summary =
    item.type === "thinking" ? undefined : activitySummary(item, workspacePath);
  const state = activityState(item);

  useEffect(() => {
    if (
      item.type === "thinking" &&
      !item.complete &&
      expanded &&
      detailsRef.current !== null
    ) {
      detailsRef.current.scrollTop = detailsRef.current.scrollHeight;
    }
  }, [expanded, item]);

  return (
    <article
      className={`activity-item activity-${state} activity-kind-${item.type === "tool" ? item.kind : item.type}`}
    >
      <button
        className="activity-toggle"
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${title}${summary === undefined ? "" : ` ${summary}`} activity`}
        onClick={() => onToggle(item, hasChildren)}
      >
        <span className="disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="activity-state-icon" aria-hidden="true">
          {item.type === "followUp" ? "↳" : activityIcon(state)}
        </span>
        <strong>{title}</strong>
        {summary !== undefined && (
          <span className="activity-summary">{summary}</span>
        )}
      </button>
      <div
        ref={detailsRef}
        className={`activity-details${item.type === "thinking" ? " thought-details" : ""}`}
        hidden={!expanded}
      >
        {item.type === "followUp" ? (
          <>
            <p className="follow-up-text">{item.text}</p>
            {item.references !== undefined && item.references.length > 0 && (
              <div className="message-references" aria-label="Referenced files">
                {item.references.map((reference) => (
                  <span className="message-reference" key={reference.id}>
                    <span aria-hidden="true">
                      {reference.source === "attachment" ? "📎" : "@"}
                    </span>{" "}
                    {reference.displayName}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : item.type === "assistant" || item.type === "thinking" ? (
          <MarkdownMessage
            source={item.text || (item.type === "thinking" ? "Thinking…" : "")}
            onOpenLink={onOpenLink}
          />
        ) : (
          <>
            {item.kind === "subagent" && item.subagentName !== undefined && (
              <span className="subagent-name">{item.subagentName}</span>
            )}
            {item.detail !== undefined && <code>{item.detail}</code>}
            {item.output !== undefined && <pre>{item.output}</pre>}
            <span className="activity-state-label">
              {item.background && item.state === "running"
                ? "Running in background"
                : activityStateLabel(state)}
            </span>
          </>
        )}
        {node.children.length > 0 && (
          <div className="nested-activities">
            {node.children.map((child) => (
              <ActivityItem
                key={`${child.item.type}-${child.item.id}`}
                node={child}
                expansion={expansion}
                {...(workspacePath === undefined ? {} : { workspacePath })}
                onToggle={onToggle}
                onOpenLink={onOpenLink}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

type ActivityState = "running" | "completed" | "failed" | "cancelled";

function activityState(item: ProcessingActivity): ActivityState {
  if (item.type === "followUp") {
    return "completed";
  }
  if (item.type === "assistant" || item.type === "thinking") {
    return item.cancelled === true
      ? "cancelled"
      : item.complete
        ? "completed"
        : "running";
  }
  return item.state === "succeeded" ? "completed" : item.state;
}

function activityIcon(state: ActivityState): string {
  switch (state) {
    case "running":
      return "●";
    case "completed":
      return "✓";
    case "failed":
      return "✕";
    case "cancelled":
      return "⊘";
  }
}

function activityStateLabel(state: ActivityState): string {
  switch (state) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function useCurrentTime(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
