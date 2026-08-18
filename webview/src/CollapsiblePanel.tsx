import { useId, useState, type ReactNode } from "react";

export interface CollapsiblePanelProps {
  readonly title: string;
  readonly count: string;
  readonly meta?: string;
  readonly children: ReactNode;
  readonly defaultExpanded?: boolean;
}

export function CollapsiblePanel({
  title,
  count,
  meta,
  children,
  defaultExpanded = false,
}: CollapsiblePanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();

  return (
    <section className={`collapsible-panel${expanded ? " is-expanded" : ""}`}>
      <button
        className="collapsible-panel-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="collapsible-panel-chevron" aria-hidden="true" />
        <span className="collapsible-panel-title">
          {title} <span>({count})</span>
        </span>
        {meta !== undefined && (
          <span className="collapsible-panel-meta">{meta}</span>
        )}
      </button>
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
