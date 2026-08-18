import { MarkdownMessage } from "./MarkdownMessage.js";
import { ProcessingSection } from "./ProcessingSection.js";
import type { AgentTurnViewModel } from "./presentation.js";
import type { UserTimelineItem } from "../../src/webview/messages.js";
import { TokenCount } from "./TokenCount.js";

interface AgentTurnProps {
  readonly turn: AgentTurnViewModel;
  readonly workspacePath?: string;
  readonly onOpenLink: (href: string) => void;
  readonly canRetry: boolean;
  readonly onRetry: (id: string) => void;
  readonly onEdit: (user: UserTimelineItem) => void;
  readonly onRestoreFiles: (id: string) => void;
}

export function AgentTurn({
  turn,
  workspacePath,
  onOpenLink,
  canRetry,
  onRetry,
  onEdit,
  onRestoreFiles,
}: AgentTurnProps): React.JSX.Element {
  const lastProcessingIndex = findLastProcessingIndex(turn.segments);
  return (
    <div className="conversation-turn">
      <article className="message user-message">
        <div className="message-heading">
          <div className="eyebrow">You</div>
          <div className="message-actions">
            {turn.user.canRestoreFiles === true && (
              <button
                type="button"
                className="message-action"
                disabled={!canRetry}
                title="Restore files to before this prompt"
                aria-label="Restore files to before this prompt"
                onClick={() => onRestoreFiles(turn.user.id)}
              >
                <RestoreIcon />
              </button>
            )}
            {turn.user.canEdit === true && (
              <button
                type="button"
                className="message-action"
                disabled={!canRetry}
                title="Edit this prompt"
                aria-label="Edit this prompt"
                onClick={() => onEdit(turn.user)}
              >
                <EditIcon />
              </button>
            )}
            <button
              type="button"
              className="message-action"
              disabled={!canRetry}
              title="Retry this prompt"
              aria-label="Retry this prompt"
              onClick={() => onRetry(turn.user.id)}
            >
              <RetryIcon />
            </button>
          </div>
        </div>
        {turn.user.references !== undefined &&
          turn.user.references.length > 0 && (
            <div className="message-references" aria-label="Referenced files">
              {turn.user.references.map((reference) => (
                <span className="message-reference" key={reference.id}>
                  <span aria-hidden="true">
                    {reference.source === "attachment" ? "📎" : "@"}
                  </span>{" "}
                  {reference.displayName}
                </span>
              ))}
            </div>
          )}
        <MarkdownMessage source={turn.user.text} onOpenLink={onOpenLink} />
        <TokenCount count={turn.user.tokenCount} />
      </article>
      <div className="turn-responses">
        {turn.segments.map((segment, index) =>
          segment.type === "processing" ? (
            <ProcessingSection
              key={segment.id}
              turnId={segment.id}
              activities={segment.activities}
              status={segment.status}
              {...(turn.turnUsage === undefined || index !== lastProcessingIndex
                ? {}
                : { turnUsage: turn.turnUsage.usage })}
              {...(workspacePath === undefined ? {} : { workspacePath })}
              onOpenLink={onOpenLink}
            />
          ) : (
            <article
              className="message assistant-message direct-assistant-message"
              key={segment.id}
            >
              <div className="eyebrow">Qwen</div>
              <MarkdownMessage
                source={segment.item.text || "…"}
                onOpenLink={onOpenLink}
              />
            </article>
          ),
        )}
        {turn.errors.map((error) => (
          <section className="error-message" role="alert" key={error.id}>
            <strong>Error</strong>
            <p>{error.message}</p>
          </section>
        ))}
        {turn.finalResponse !== undefined && (
          <article className="message assistant-message final-assistant-message">
            <div className="eyebrow">Qwen</div>
            <MarkdownMessage
              source={turn.finalResponse.text}
              className="final-response"
              onOpenLink={onOpenLink}
            />
            <TokenCount
              count={turn.finalResponse.tokenCount}
              {...(turn.finalResponse.turnUsage === undefined
                ? {}
                : { turnUsage: turn.finalResponse.turnUsage })}
            />
          </article>
        )}
      </div>
    </div>
  );
}

function RetryIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 5.2A5.5 5.5 0 1 1 2.5 9" />
      <path d="M3.2 1.8v3.4H6.6" />
    </svg>
  );
}

function EditIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m10.8 2.2 3 3-8.2 8.2-3.7.7.7-3.7 8.2-8.2Z" />
      <path d="m9.6 3.4 3 3" />
    </svg>
  );
}

function RestoreIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 5.2A5.5 5.5 0 1 1 2.5 9" />
      <path d="M3 1.8v3.4h3.4" />
      <path d="M8 5.2v3l2 1.2" />
    </svg>
  );
}

function findLastProcessingIndex(
  segments: AgentTurnViewModel["segments"],
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.type === "processing") return index;
  }
  return -1;
}
