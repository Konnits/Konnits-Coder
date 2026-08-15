import { useEffect, useState } from "react";
import { ActivityItem } from "./ActivityItem.js";
import {
  buildActivityTree,
  initialProcessingExpansion,
  processingSummary,
  setProcessingExpanded,
  toggleActivityExpansion,
  updateProcessingExpansion,
  type ProcessingActivity,
  type ProcessingStatus,
} from "./presentation.js";
import type { TurnTokenUsage } from "../../src/agent/TokenUsage.js";
import { TurnUsageSummary } from "./TurnUsageSummary.js";

interface ProcessingSectionProps {
  readonly turnId: string;
  readonly activities: readonly ProcessingActivity[];
  readonly status: ProcessingStatus;
  readonly turnUsage?: TurnTokenUsage;
  readonly workspacePath?: string;
  readonly onOpenLink: (href: string) => void;
}

export function ProcessingSection({
  turnId,
  activities,
  status,
  turnUsage,
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
  const activityTree = buildActivityTree(activities);
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
        <span className="processing-summary">
          {summary}
          {turnUsage !== undefined && <TurnUsageSummary usage={turnUsage} />}
        </span>
      </button>
      <div
        id={`processing-${turnId}`}
        className="processing-items"
        hidden={!expansion.expanded}
      >
        {activityTree.map((node) => (
          <ActivityItem
            key={`${node.item.type}-${node.item.id}`}
            node={node}
            expansion={itemExpansion}
            workspacePath={workspacePath}
            onOpenLink={onOpenLink}
            onToggle={(item) =>
              setItemExpansion((current) =>
                toggleActivityExpansion(current, item),
              )
            }
          />
        ))}
      </div>
    </section>
  );
}
