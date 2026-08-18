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
- Browse Qwen-owned workspace history, restore transcripts and sessions, and safely delete inactive sessions.

## M10 — UX polish and packaging

- Keyboard and screen-reader audit.
- Extension Host tests for command/provider registration.
- VSIX size review; evaluate external CLI versus bundled SDK CLI packaging.
- Compact active-model selector plus native select/add/edit/open flows for Qwen-owned provider configuration.
- Authenticated OpenAI-compatible `/models` diagnostics and remote LM Studio setup.
- Conflict-safe user settings and `.env` writes with workspace-override warnings.
- Rich slash-command metadata and native Chat History picker.
- Unified dynamic slash-command routing with native `/help`, daemon-backed `/agents` listing, and local unavailable/unknown results.
- Segmented Processing/Qwen message presentation, prompt retry/edit controls, and conflict-safe in-memory file checkpoints backed by Qwen conversation rewind.
- Native agent permission picker with fail-closed, risk-acknowledged full access.

## Future, not MVP

- A daemon-backed `AgentClient` after Qwen's permission/reconnection contract is stable.
- Safe attribution for command-generated file changes, likely using a Qwen-owned worktree or supported pre-apply edit protocol.
- Multi-root session selection and multiple concurrent sessions.
- Multi-workspace history aggregation and optional richer persisted transcript summaries.
- Optional real-Qwen/LM Studio end-to-end suite, separate from normal tests.
- Optional model removal after a safe credential-reference policy is defined; model refresh currently occurs on view readiness and picker actions rather than through a file watcher.
- Native agent create/edit/delete after scope-aware validation, confirmations, read-only handling, and coordinated agent-cache refresh are designed.
