# ADR 0003: Hash-guarded session change review

## Context

The SDK applies approved edits to the real working tree and has no supported virtual staging hook. Blind rollback can destroy user work.

## Decision

Snapshot dedicated edit targets before permission, capture their result, and permit accept/reject only while the live file exactly matches that result and no editor is dirty. Mark ambiguity as conflicted.

## Alternatives

- Whole-workspace snapshots are expensive and collect unrelated/sensitive data.
- Git reset/checkout can destroy unrelated work and assumes a repository.
- Pretending edits are staged is inconsistent with the actual SDK.

## Consequences

Review is safe for dedicated edit tools. Shell-only mutations are not automatically reversible. A future supported worktree/interception API can introduce true staging.
