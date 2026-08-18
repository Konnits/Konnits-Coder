# ADR 0012: Require explicit scope for external edits

## Context

Dedicated Qwen edit tools can target configuration or project files outside the
currently open workspace. Konnits-Coder previously denied every such edit
because it could not capture the pre-edit content under its workspace-only
change-review boundary. Users could add the directory manually, but the error
did not offer that workflow and unsafe command or Full access workarounds would
bypass Changed Files review.

## Decision

When a dedicated edit target resolves outside every open workspace folder,
request an explicit scope choice. The user can authorize only that exact file
for the current edit, or add the target's immediate parent directory as a VS
Code workspace folder. Show the exact target and proposed folder. Create the
folder only after the second choice and use the stable public
`workspace.updateWorkspaceFolders` API to request inclusion.

Use an exact-file approval only for the in-flight tool's snapshot and completion;
later tools must request permission again. For folder inclusion, later tools
must find the directory in VS Code's actual workspace-folder list, so removing a
folder also removes edit eligibility. Do not offer filesystem roots for folder
inclusion, retain no authorization after rejection or API failure, and continue
routing every resulting proposal through the existing hash, dirty-editor, diff,
Keep, Undo, and checkpoint protections.

## Alternatives

- Keep denying external edits and improve only the error: rejected because it
  leaves a common configuration workflow unnecessarily manual.
- Require workspace inclusion for every external edit: rejected because a
  one-time exact-file grant is sufficient for configuration files and avoids
  expanding the agent's durable workspace scope.
- Remember exact-file approval for the session: rejected because later tools
  must not inherit an earlier narrow authorization silently.
- Add the user profile or another broad ancestor automatically: rejected
  because it expands agent visibility and write scope beyond the requested
  file.
- Recommend Full access or a shell command: rejected because those paths can
  bypass pre-edit snapshots and safe rejection.

## Consequences

External dedicated-tool edits become reviewable without silently broadening the
workspace. The user may receive both the ordinary write approval and the
external-scope confirmation. Exact-file approval is intentionally ephemeral. VS
Code may restart the extension host when converting a single-folder workspace
to multi-root; if that interrupts the operation, the folder remains included
and the user can retry safely. Full access still bypasses the permission callback
and therefore cannot promise this workflow or complete change capture.
