# ADR 0010: Split conversation rewind from safe file restoration

## Context

Editing an earlier prompt must remove the edited turn and everything after it
from both the visible timeline and Qwen's actual model history. It must also be
able to return agent-modified files to their earlier state without overwriting
independent user work.

The direct Qwen `Query` API can resume and fork but cannot rewind. The public
daemon API can rewind a session and optionally invoke Qwen's file history.
Konnits already owns stricter file proposals, dirty-editor checks, and content
hash conflict detection than that external restoration path.

## Decision

Capture an in-memory `ChangeManager` checkpoint before every locally submitted
prompt. Prompt editing performs these operations:

1. preflight every affected tracked file;
2. capture a temporary checkpoint of the newer state;
3. restore the target file checkpoint through `ChangeManager`;
4. start an extension-owned temporary Qwen daemon and rewind the Qwen session
   to the matching public prompt snapshot with `rewindFiles: false`;
5. truncate the local timeline and submit the replacement through the existing
   direct SDK adapter.

If step 4 fails, restore the temporary newer checkpoint. A standalone restore
button performs only steps 1 and 3 and leaves the conversation untouched.

## Alternatives

- Delete or rewrite Qwen JSONL transcripts directly: rejected because the
  format, UUID ancestry, compaction records, and file history are Qwen-owned.
- Let Qwen daemon restore files: rejected because it can overwrite paths without
  the extension's dirty-document and independent-edit checks.
- Start a fresh session and replay visible text: rejected because visible text
  omits system context, tool results, thinking boundaries, and other Qwen-owned
  state.
- Persist full checkpoints: rejected because it retains potentially sensitive
  workspace contents beyond the active extension lifetime.

## Consequences

Conversation and file restoration each use their authoritative boundary. The
feature depends on Qwen's daemon rewind capability and cannot edit compacted
turns. Only safely tracked dedicated-tool edits are restorable; arbitrary shell
mutations remain outside the guarantee. Checkpoint buttons are unavailable for
history loaded after extension restart.
