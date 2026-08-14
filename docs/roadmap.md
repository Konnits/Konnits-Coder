# Roadmap

## M0 — Research and architecture

- Official SDK/daemon/VS Code API validation.
- Direct SDK, webview, and session-mode review decisions.
- Change safety design and ADRs.

## M1–M3 — Skeleton, connection, streaming chat

- Strict TypeScript extension/webview builds.
- Activity Bar webview, configuration, logging, typed messages.
- `AgentClient`, SDK connection, resumable sessions, streaming, cancellation.

## M4–M8 — Activity and review MVP

- Typed read/search/edit/command/test rendering.
- Interactive SDK tool permissions.
- Dedicated edit target tracking.
- Native diff, per-file/bulk accept and reject, conflict detection.

## M9 — Session persistence

- Persist workspace-scoped session IDs.
- Add explicit new-session behavior without persisting transcript or file contents.

## M10 — UX polish and packaging

- Keyboard and screen-reader audit.
- Extension Host tests for command/provider registration.
- VSIX size review; evaluate external CLI versus bundled SDK CLI packaging.
- Optional model/provider diagnostics surfaced from Qwen without owning provider configuration.

## Future, not MVP

- A daemon-backed `AgentClient` after Qwen's permission/reconnection contract is stable.
- Safe attribution for command-generated file changes, likely using a Qwen-owned worktree or supported pre-apply edit protocol.
- Multi-root session selection and multiple concurrent sessions.
- Persisted transcript summaries and reconnection replay.
- Optional real-Qwen/LM Studio end-to-end suite, separate from normal tests.
