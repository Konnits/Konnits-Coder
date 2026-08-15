# ADR 0007: Preserve Qwen sessions across turn cancellation

## Context

The SDK exposes two different cancellation mechanisms. `Query.interrupt()` is
the in-session control request intended to stop the current Qwen turn. The
`QueryOptions.abortController` is a transport-level cancellation primitive;
the bundled SDK uses it to close the query and terminate the child Qwen
process.

Konnits-Coder creates one query per turn and resumes established sessions by
ID. Calling `abort()` before `interrupt()` therefore terminated the runtime
before Qwen could record its interrupted turn. The session manager also left a
started-but-cancelled session marked unestablished, so the next prompt used a
new-session option instead of attempting the supported resume path.

## Decision

Allocate a fresh `AbortController` for every turn, but use `Query.interrupt()`
for cancellation while a live query exists. The abort controller is reserved
for cancellation before query construction or as a narrowly scoped fallback
when the interrupt request itself cannot be delivered.

Track cancellation on the active turn independently from SDK error shape.
When the interrupted iterator ends with an SDK abort/error result, map the
expected user action to `agent.cancelled`, clean up the query and permissions,
and never retry the prompt automatically.

When cancellation completes, mark the current logical session established so
the next turn uses the same session ID with `resume: true`. Missing-session
recovery remains the existing, diagnostic-gated, one-time fallback to a new
runtime session.

## Alternatives

- Abort every cancelled query: rejected because the SDK terminates the child
  process and loses the in-session interrupt/resume lifecycle.
- Keep the query open and append the next prompt to it: rejected for now
  because Konnits already uses one query per turn and the supported resume
  contract is sufficient without changing session ownership.
- Start a new session after every cancellation: rejected because it silently
  discards Qwen context and hides the lifecycle defect.
- Retry every post-cancel process failure as a new session: rejected because it
  could duplicate edits, commands, or other non-idempotent actions.

## Consequences

- A normal cancellation preserves the same Qwen session and its recorded
  context when the runtime supports interruption.
- A transport-level fallback may still require the existing missing-session
  recovery path; it is not an automatic prompt retry.
- The active-turn state explicitly owns the query, cancellation flag, and
  per-turn abort controller, making stale handles unavailable to the next
  turn.
- The live SDK regression test exercises the bundled CLI and configured local
  provider without involving the webview.
