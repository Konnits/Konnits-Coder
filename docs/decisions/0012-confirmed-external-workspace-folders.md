# ADR 0012: Require confirmed workspace inclusion for external edits

## Context

Dedicated Qwen edit tools can target configuration or project files outside the
currently open workspace. Konnits-Coder previously denied every such edit
because it could not capture the pre-edit content under its workspace-only
change-review boundary. Users could add the directory manually, but the error
did not offer that workflow and unsafe command or Full access workarounds would
bypass Changed Files review.

## Decision

When a dedicated edit target resolves outside every open workspace folder,
request explicit confirmation to add the target file's immediate parent
directory as a VS Code workspace folder. Show the exact target and proposed
folder, create that folder only after confirmation, and use the stable public
`workspace.updateWorkspaceFolders` API to request inclusion.

Use the approved URI only for the in-flight tool's snapshot and completion while
VS Code applies the workspace update. Later tools must find the directory in
VS Code's actual workspace-folder list, so removing a folder also removes edit
eligibility. Refuse filesystem roots, retain no authorization after rejection or
API failure, and continue routing every resulting proposal through the existing
hash, dirty-editor, diff, Keep, Undo, and checkpoint protections.

## Alternatives

- Keep denying external edits and improve only the error: rejected because it
  leaves a common configuration workflow unnecessarily manual.
- Allow the individual external file without adding a workspace folder:
  rejected because Qwen and the UI use the open workspace as their visible and
  trusted operating boundary.
- Add the user profile or another broad ancestor automatically: rejected
  because it expands agent visibility and write scope beyond the requested
  file.
- Recommend Full access or a shell command: rejected because those paths can
  bypass pre-edit snapshots and safe rejection.

## Consequences

External dedicated-tool edits become reviewable without silently broadening the
workspace. The user may receive both the ordinary write approval and the folder
inclusion confirmation. VS Code may restart the extension host when converting
a single-folder workspace to multi-root; if that interrupts the operation, the
folder remains included and the user can retry safely. Full access still
bypasses the permission callback and therefore cannot promise this workflow or
complete change capture.
