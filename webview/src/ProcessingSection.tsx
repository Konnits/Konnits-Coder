import { useEffect, useState } from "react";
import { ActivityItem } from "./ActivityItem.js";
import {
  initialProcessingExpansion,
  isActivityExpanded,
  processingSummary,
  setProcessingExpanded,
  toggleActivityExpansion,
  updateProcessingExpansion,
  type ProcessingActivity,
  type ProcessingStatus,
} from "./presentation.js";

interface ProcessingSectionProps {
  readonly turnId: string;
  readonly activities: readonly ProcessingActivity[];
  readonly status: ProcessingStatus;
  readonly workspacePath?: string;
  readonly onOpenLink: (href: string) => void;
}

export function ProcessingSection({
  turnId,
  activities,
  status,
  workspacePath,
  onOpenLink,
}: ProcessingSectionProps): React.JSX.Element {
  const [expansion, setExpansion] = useState(() =>
    initialProcessingExpansion(status),
  );
  const [itemExpansion, setItemExpansion] = useState<
    Readonly<Record<string, boolean>>
  >({});

  useEffect(() => {
    setExpansion((current) => updateProcessingExpansion(current, status));
  }, [status]);

  const summary = processingSummary(activities, status);
  return (
    <section
      className={`processing processing-${status}`}
      aria-label="Agent processing"
    >
      <button
        type="button"
        className="processing-toggle"
        aria-expanded={expansion.expanded}
        aria-controls={`processing-${turnId}`}
        aria-label={`${expansion.expanded ? "Collapse" : "Expand"} processing, ${summary}`}
        onClick={() =>
          setExpansion((current) =>
            setProcessingExpanded(current, !current.expanded),
          )
        }
      >
        <span className="disclosure" aria-hidden="true">
          {expansion.expanded ? "▾" : "▸"}
        </span>
        <strong>Processing</strong>
        <span className="processing-summary">{summary}</span>
      </button>
      <div
        id={`processing-${turnId}`}
        className="processing-items"
        hidden={!expansion.expanded}
      >
        {activities.map((item) => {
          const itemExpanded = isActivityExpanded(itemExpansion, item);
          return (
            <ActivityItem
              key={`${item.type}-${item.id}`}
              item={item}
              expanded={itemExpanded}
              workspacePath={workspacePath}
              onOpenLink={onOpenLink}
              onToggle={() =>
                setItemExpansion((current) =>
                  toggleActivityExpansion(current, item),
                )
              }
            />
          );
        })}
      </div>
    </section>
  );
}
