# ADR 0002: Webview view for conversation UI

## Context

The product needs a compact conversation timeline, structured tools, permissions, changed files, and prompt controls in one Activity Bar view.

## Decision

Use a public `WebviewViewProvider` with React for presentation. Communicate only through validated discriminated messages. Use native VS Code diff editors for source comparison.

## Alternatives

- Tree views and commands cannot express the conversational layout well.
- A custom HTML diff would duplicate a native editor feature.
- Proposed/private chat APIs would create compatibility risk.

## Consequences

The extension owns webview accessibility and CSP discipline, but source review remains native and the UI never receives filesystem or SDK access.
