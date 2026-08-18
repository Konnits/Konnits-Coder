interface ChatScrollRegionProps {
  readonly contentRef: React.RefObject<HTMLDivElement | null>;
  readonly following: boolean;
  readonly onJumpToLatest: () => void;
  readonly children: React.ReactNode;
  readonly bottomDock?: React.ReactNode;
}

export function ChatScrollRegion({
  contentRef,
  following,
  onJumpToLatest,
  children,
  bottomDock,
}: ChatScrollRegionProps): React.JSX.Element {
  return (
    <>
      <div className="chat-scroll-region">
        <div className="chat-body" ref={contentRef}>
          {children}
        </div>
        {!following && (
          <button
            className="jump-latest"
            type="button"
            aria-label="Jump to latest message"
            title="Jump to latest"
            onClick={onJumpToLatest}
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
      {bottomDock !== undefined && bottomDock !== null && (
        <div className="chat-bottom-dock">{bottomDock}</div>
      )}
    </>
  );
}
