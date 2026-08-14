import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownMessageProps {
  readonly source: string;
  readonly className?: string;
  readonly onOpenLink?: (href: string) => void;
}

export function MarkdownMessage({
  source,
  className,
  onOpenLink,
}: MarkdownMessageProps): React.JSX.Element {
  return (
    <div
      className={`markdown-message${className === undefined ? "" : ` ${className}`}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href !== undefined && isSafeExternalHref(href) ? (
              <a
                href="#"
                aria-label={`Open external link: ${href}`}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLink?.(href);
                }}
              >
                {children}
              </a>
            ) : (
              <span className="unsupported-link">{children}</span>
            ),
          table: ({ children }) => (
            <div
              className="markdown-table-scroll"
              role="region"
              aria-label="Scrollable table"
            >
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => (
            <pre className="markdown-code-block">{children}</pre>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export function isSafeExternalHref(href: string): boolean {
  try {
    return new Set(["http:", "https:", "mailto:"]).has(new URL(href).protocol);
  } catch {
    return false;
  }
}
