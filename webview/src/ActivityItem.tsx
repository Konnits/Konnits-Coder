import { MarkdownMessage } from "./MarkdownMessage.js";
import { activitySummary, type ProcessingActivity } from "./presentation.js";

interface ActivityItemProps {
  readonly item: ProcessingActivity;
  readonly expanded: boolean;
  readonly workspacePath?: string;
  readonly onToggle: () => void;
  readonly onOpenLink: (href: string) => void;
}

export function ActivityItem({
  item,
  expanded,
  workspacePath,
  onToggle,
  onOpenLink,
}: ActivityItemProps): React.JSX.Element {
  const title = item.type === "assistant" ? "Qwen" : item.title;
  const summary = activitySummary(item, workspacePath);
  const state = activityState(item);
  return (
    <article className={`activity-item activity-${state}`}>
      <button
        className="activity-toggle"
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${title}${summary === undefined ? "" : ` ${summary}`} activity`}
        onClick={onToggle}
      >
        <span className="disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="activity-state-icon" aria-hidden="true">
          {activityIcon(state)}
        </span>
        <strong>{title}</strong>
        {summary !== undefined && (
          <span className="activity-summary">{summary}</span>
        )}
      </button>
      <div className="activity-details" hidden={!expanded}>
        {item.type === "assistant" ? (
          <MarkdownMessage
            source={item.text || "Thinking…"}
            onOpenLink={onOpenLink}
          />
        ) : (
          <>
            {item.detail !== undefined && <code>{item.detail}</code>}
            {item.output !== undefined && <pre>{item.output}</pre>}
            <span className="activity-state-label">
              {activityStateLabel(state)}
            </span>
          </>
        )}
      </div>
    </article>
  );
}

type ActivityState = "running" | "completed" | "failed";

function activityState(item: ProcessingActivity): ActivityState {
  if (item.type === "assistant") {
    return item.complete ? "completed" : "running";
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
  }
}
