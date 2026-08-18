# Change review design

## Decision

The MVP uses working-tree session review because the current Qwen SDK does not expose a supported pre-apply virtual edit layer. Qwen Code remains the writer. The extension captures exact content around dedicated write tools and overlays review state on the resulting working tree.

## Ownership record

Each proposed change stores:

- stable change ID and workspace URI;
- original content, or `null` when the file did not exist;
- proposed content, or `null` when the agent deleted it;
- SHA-256 hashes for both sides;
- additions/deletions;
- `pending`, `accepted`, `rejected`, or `conflicted` status;
- creation/update timestamps and an optional conflict explanation.

The first snapshot for a still-pending file remains the session base. Later Qwen edit tools update only its proposed side, so rejecting all edits to that file returns to the pre-agent state.

## Capture flow

1. Qwen requests a dedicated edit/write tool.
2. The permission callback extracts its absolute `file_path`/`path` and verifies it is inside the workspace.
3. Before approval, the extension reads the file or records that it is absent.
4. Qwen runs the tool.
5. On its tool result, the extension reads the target again and records the proposal if content changed.

Reads/searches need no snapshot. Shell commands still require user approval but are not assumed to be non-mutating.

The SDK's automatic permission modes can bypass the permission callback, which
would also bypass the pre-tool snapshot in step 3. Until change capture moves to
a Qwen-supported interception/worktree boundary, the frontend exposes only
`default` and read-only `plan`; `auto-edit`, `auto`, and `yolo` are intentionally
unavailable.

## Review

Both sides of the diff are immutable `qwen-review:` virtual documents. This keeps review deterministic even if the working file later changes. The title includes the workspace-relative file name.

The chat UI follows VS Code's current review terminology: **Keep** maps to the internal accept operation and **Undo** maps to the internal reject operation. This is a presentation choice only; the verified state transitions and conflict checks below remain unchanged. Added, modified, and deleted badges are derived from the captured original/proposed existence rather than inferred from Git state.

## Accept

Accept means “keep the already-applied Qwen result.” Before changing status, the manager requires:

- no dirty open editor for the file; and
- live content/existence exactly equal to the captured proposed side.

If either check fails, the change becomes conflicted and nothing is written.

## Reject

Reject first applies the same proposed-side verification. Only then:

- modified/deleted existing file: restore the exact original bytes;
- agent-created file: delete only that exact unchanged file;
- agent-deleted file: recreate only if the path remains absent.

After the write/delete, the manager verifies the resulting original side before marking `rejected`. Any ambiguity becomes `conflicted`; user edits are never silently overwritten.

## Bulk operations

Accept All and Reject All process pending files independently. A conflict in one file does not authorize writes to it and does not prevent safe transitions for other files. The UI reports all resulting statuses.

## Concurrent/manual edits

The live proposed-content hash and dirty-document check are the destructive-operation guard. If a user changes a pending file after Qwen's proposal, reject cannot overwrite it. The user can still inspect the immutable proposal and manually reconcile it.

## Per-prompt checkpoints

Before each normal prompt, `ChangeManager` records the exact disk state and
change metadata for files already tracked in the session. A file first changed
after that checkpoint uses the first captured `originalContent` as its target.
Restore preflights every affected URI before writing: dirty editors, conflicted
records, and content that no longer matches the latest captured agent state stop
the complete operation.

Writes are verified. If a multi-file restore fails partway through, the manager
attempts to put already-written files back to their pre-operation contents and
marks rollback failures conflicted. Editing a prompt additionally captures a
temporary forward checkpoint, so a failed Qwen conversation rewind restores the
newer files before reporting the failure.

Checkpoints are intentionally not persisted because they contain complete file
contents. They cannot cover arbitrary shell mutations that bypass dedicated edit
tracking.

There is a smaller race between the pre-tool snapshot and post-tool capture. The extension cannot prove byte-level authorship if a human edits the same file during that window. The final rejection guard prevents later overwrites but cannot separate interleaved bytes. The UI therefore labels the mechanism session tracking rather than staging.

## Shell limitation

An arbitrary command can modify unbounded paths. Snapshotting the entire repository for every command is expensive, copies sensitive/large content, and still races with user edits. The MVP relies on Qwen's dedicated editing tools for reviewable changes and does not fabricate rollback data for shell-only changes. A future Qwen-supported worktree or edit interception API is the correct solution.
