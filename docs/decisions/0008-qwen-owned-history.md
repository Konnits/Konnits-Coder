# ADR 0008: Use Qwen-owned session history

## Context

Qwen persists chat sessions as workspace-scoped JSONL transcripts and exposes
`qwen sessions list --json`. The VS Code frontend needs searchable history,
transcript restoration, and deletion without creating a second chat database
or silently replaying old tools.

## Decision

`QwenSessionHistoryService` uses Qwen's JSONL list command as the session
catalog. It filters records to canonical open workspace roots, loads selected
transcripts through a display-only `QwenTranscriptLoader`, and restores the
actual session through an SDK query using `resume` with no user input. Deletion
is allowed only for validated UUID-named Qwen paths whose first transcript
record matches the selected session and workspace. The current session is
protected in the picker.

## Alternatives

- Persist a separate extension chat database: rejected because it duplicates
  Qwen state and can diverge from the session used for the next prompt.
- Reuse `/resume` inside the chat: rejected because it invokes Qwen's own
  interactive dialog and does not provide the frontend transcript UX.
- Replay historical prompts/tools to reconstruct state: rejected because it
  can invoke inference or mutate the workspace.
- Delete arbitrary files under `.qwen`: rejected because it risks unrelated
  user data and does not honor Qwen's session ownership rules.

## Consequences

The frontend stays aligned with Qwen's session IDs and transcripts, and
history browsing does not require model inference. The implementation must
track Qwen's JSONL schema and session file layout, so runtime validation and
focused parser/deletion tests remain required when the SDK changes.
