# ADR 0009: Expose only permission modes compatible with change capture

## Context

Qwen Code SDK 0.1.8 supports `default`, `plan`, `auto-edit`, `auto`, and `yolo`
permission modes. Konnits captures a file's original bytes inside `canUseTool`
before approving a dedicated edit tool. The installed SDK can authorize tools
without calling that callback in the automatic modes, so exposing those modes
would make some agent edits impossible to undo safely.

## Decision

Expose a native VS Code setting and composer shortcut for only two modes:

- `default`, which routes sensitive tools through explicit permission and the
  existing snapshot boundary;
- `plan`, which remains read-only.

Parse unknown or legacy values as `default`, pass the normalized value only at
new-query construction, and keep SDK-specific permission types below the
`AgentClient` boundary.

## Alternatives

- Expose every SDK mode and disable review selectively: rejected because an
  apparently reviewable session could contain edits without a safe base.
- Snapshot the whole workspace around automatic execution: rejected because it
  is expensive, copies unrelated/sensitive content, and cannot attribute races.
- Reimplement Qwen tool execution in the extension: rejected because Qwen Code
  owns agent behavior and tool semantics.

## Consequences

Users can choose approval-based execution or a read-only planning mode from the
composer. Fully automatic modes remain unavailable until Qwen exposes a
supported edit interception or isolated-worktree contract. Changing the setting
affects the next query, not one already running.
