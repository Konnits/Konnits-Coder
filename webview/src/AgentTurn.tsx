import { MarkdownMessage } from "./MarkdownMessage.js";
import { ProcessingSection } from "./ProcessingSection.js";
import type { AgentTurnViewModel } from "./presentation.js";
import { TokenCount } from "./TokenCount.js";

interface AgentTurnProps {
  readonly turn: AgentTurnViewModel;
  readonly workspacePath?: string;
  readonly onOpenLink: (href: string) => void;
}

export function AgentTurn({
  turn,
  workspacePath,
  onOpenLink,
}: AgentTurnProps): React.JSX.Element {
  const showProcessing =
    turn.activities.length > 0 ||
    turn.status === "working" ||
    turn.status === "waiting" ||
    turn.status === "cancelling";
  return (
    <div className="conversation-turn">
      <article className="message user-message">
        <div className="eyebrow">You</div>
        {turn.user.references !== undefined &&
          turn.user.references.length > 0 && (
            <div className="message-references" aria-label="Referenced files">
              {turn.user.references.map((reference) => (
                <span className="message-reference" key={reference.id}>
                  <span aria-hidden="true">@</span> {reference.displayName}
                </span>
              ))}
            </div>
          )}
        <p>{turn.user.text}</p>
        <TokenCount count={turn.user.tokenCount} />
      </article>
      <article className="message assistant-message">
        <div className="eyebrow">Qwen</div>
        {showProcessing && (
          <ProcessingSection
            turnId={turn.id}
            activities={turn.activities}
            status={turn.status}
            turnUsage={turn.turnUsage?.usage}
            workspacePath={workspacePath}
            onOpenLink={onOpenLink}
          />
        )}
        {turn.errors.map((error) => (
          <section className="error-message" role="alert" key={error.id}>
            <strong>Error</strong>
            <p>{error.message}</p>
          </section>
        ))}
        {turn.finalResponse !== undefined && (
          <>
            <MarkdownMessage
              source={turn.finalResponse.text}
              className="final-response"
              onOpenLink={onOpenLink}
            />
            <TokenCount
              count={turn.finalResponse.tokenCount}
              turnUsage={turn.finalResponse.turnUsage}
            />
          </>
        )}
      </article>
    </div>
  );
}
