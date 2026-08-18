# ADR 0011: Gate full agent access behind explicit risk acknowledgement

## Context

Qwen's `yolo` permission mode auto-approves every tool before the SDK invokes
`canUseTool`. Users need an intentional way to run unattended agent turns, but
that mode can execute commands, modify or delete files, reach paths allowed by
the host environment, and bypass the snapshot boundary used by Konnits Coder's
change review and prompt restoration.

ADR 0009 previously excluded all modes that bypassed change capture. Full
access is now an explicit product requirement, so silently treating it as an
ordinary preference would understate its consequences.

## Decision

Expose three permission modes through a native picker: `default`, `plan`, and
`yolo` (labelled **Full access**). Require a modal declaration before enabling
full access. The warning names the approval, command, deletion,
out-of-workspace, snapshot, and restoration risks.

Store acknowledgement in workspace-scoped extension state. Configuration and
Qwen query creation use the effective mode from a centralized service. A
`yolo` value written directly to settings remains fail-closed as `default`
until the modal is accepted. Returning to a safer mode clears the
acknowledgement. Mode changes apply to newly created Qwen queries rather than
mutating an active turn.

## Alternatives

- Enable `yolo` directly from the setting: rejected because it provides no
  reliable, contextual risk declaration.
- Store one global acknowledgement: rejected because consent in one project
  should not silently authorize every workspace.
- Pretend change restoration remains complete: rejected because the SDK
  explicitly bypasses the callback where dedicated edits are captured.
- Keep full access unavailable: superseded because unattended execution is now
  a requested workflow.

## Consequences

Users can intentionally run Qwen without approval prompts after declaring that
they understand the risks. Unacknowledged or malformed configuration remains
safe. While full access is active, Konnits Coder cannot guarantee that Changed
Files, prompt editing, or restoration includes every agent mutation. The
composer permission icon visibly indicates full-access mode.
