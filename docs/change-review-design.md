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

## Review

Both sides of the diff are immutable `qwen-review:` virtual documents. This keeps review deterministic even if the working file later changes. The title includes the workspace-relative file name.

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

There is a smaller race between the pre-tool snapshot and post-tool capture. The extension cannot prove byte-level authorship if a human edits the same file during that window. The final rejection guard prevents later overwrites but cannot separate interleaved bytes. The UI therefore labels the mechanism session tracking rather than staging.

## Shell limitation

An arbitrary command can modify unbounded paths. Snapshotting the entire repository for every command is expensive, copies sensitive/large content, and still races with user edits. The MVP relies on Qwen's dedicated editing tools for reviewable changes and does not fabricate rollback data for shell-only changes. A future Qwen-supported worktree or edit interception API is the correct solution.
