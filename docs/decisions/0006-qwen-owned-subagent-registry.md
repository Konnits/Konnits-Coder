# ADR 0006: Use Qwen's Daemon Registry for SDK Subagents

## Context

The Qwen SDK's local stream transport enters SDK mode. In that mode Qwen only
exposes subagents supplied through the session `agents` option; filesystem and
built-in discovery is not implicitly copied into the SDK session. An IDE client
that sends no option therefore receives an empty model-visible registry even
though the same Qwen CLI can list `general-purpose` and `Explore` interactively.

The frontend must not become a second Qwen agent implementation or silently
choose a different runtime than the one used for execution.

## Decision

Before the first SDK query for a workspace, Konnits starts the configured Qwen
runtime's own temporary daemon, asks its public workspace-agent endpoints for
the authoritative definitions, closes the daemon, and passes the returned
definitions as `QueryOptions.agents`. The SDK query still launches the same
configured runtime and Qwen remains responsible for loading and executing the
definitions.

Konnits may inspect the conventional user and project agent directories only
to report diagnostics. It does not execute those files, synthesize built-ins,
or patch the bundled Qwen package. Discovery failures omit `agents` rather than
passing an empty array, and the output channel records workspace, runtime,
model-visible names, and discovery errors.

## Alternatives

1. Read `.qwen/agents` directly and construct session definitions. Rejected:
   this duplicates Qwen's precedence, validation, built-ins, and future format
   behavior.
2. Hard-code `general-purpose` and `Explore`. Rejected: this hides custom,
   extension, and version-specific agents and can diverge from Qwen.
3. Switch the extension to the global CLI or a daemon-only execution path.
   Rejected: users may configure a bundled or project runtime, and the SDK
   remains the extension's execution abstraction.
4. Pass `agents: []` when discovery is unavailable. Rejected: an empty array
   explicitly removes the runtime's session registry and recreates the original
   “subagent not found” failure.

## Consequences

- Built-in and configured agents are available to SDK-mode sessions without
  coupling domain code to Qwen's internal registry classes.
- Startup incurs one short-lived daemon discovery process per runtime/workspace
  cache key. If it cannot start, execution remains possible and diagnostics make
  the missing registry visible.
- The daemon and SDK must come from the selected Qwen runtime. Version and
  source diagnostics are therefore retained and live tests still exercise the
  real runtime/model path.
