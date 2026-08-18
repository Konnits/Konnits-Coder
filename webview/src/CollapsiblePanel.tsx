import { useId, useState, type ReactNode } from "react";

export interface CollapsiblePanelProps {
  readonly title: string;
  readonly count: string;
  readonly meta?: string;
  readonly children: ReactNode;
  readonly defaultExpanded?: boolean;
  readonly alwaysExpanded?: boolean;
  readonly headerAction?: ReactNode;
}

export function CollapsiblePanel({
  title,
  count,
  meta,
  children,
  defaultExpanded = false,
  alwaysExpanded = false,
  headerAction,
}: CollapsiblePanelProps): React.JSX.Element {
  const [userExpanded, setUserExpanded] = useState(defaultExpanded);
  const expanded = alwaysExpanded || userExpanded;
  const contentId = useId();

  return (
    <section className={`collapsible-panel${expanded ? " is-expanded" : ""}`}>
      <div className="collapsible-panel-header">
        {alwaysExpanded ? (
          <div className="collapsible-panel-static-heading">
            <span className="collapsible-panel-title">
              {title} <span>({count})</span>
            </span>
            {meta !== undefined && (
              <span className="collapsible-panel-meta">{meta}</span>
            )}
          </div>
        ) : (
          <button
            className="collapsible-panel-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setUserExpanded((current) => !current)}
          >
            <span className="collapsible-panel-chevron" aria-hidden="true" />
            <span className="collapsible-panel-title">
              {title} <span>({count})</span>
            </span>
            {meta !== undefined && (
              <span className="collapsible-panel-meta">{meta}</span>
            )}
          </button>
        )}
        {headerAction}
      </div>
      <div
        className="collapsible-panel-content"
        id={contentId}
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}
