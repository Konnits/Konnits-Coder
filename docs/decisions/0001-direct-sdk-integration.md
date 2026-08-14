# ADR 0001: Direct TypeScript SDK integration

## Context

Qwen supports direct SDK queries and an experimental HTTP/SSE daemon. The daemon offers process sharing and replay, but its official design documentation still records permission coordination gaps and an in-progress VS Code migration.

## Decision

Use `@qwen-code/sdk` direct queries for the MVP behind `AgentClient`. A newly allocated workspace session is not resumable until Qwen completes its first request successfully. Persist that established state and resume subsequent requests by ID. If Qwen reports that a legacy or interrupted persisted session ID does not exist, retry that request exactly once as a new session with the same ID. Do not start or manage `qwen serve` yet.

Use the SDK-bundled CLI by default because a live authenticated LM Studio request verified that it supports the current version-4 Qwen settings and provider model. Preserve `qwenFrontend.qwen.executablePath` as an explicit supported override; do not add custom global-CLI discovery while the SDK already provides deterministic bundled resolution.

## Alternatives

- Daemon client: stronger shared-session topology, but currently experimental and riskier for interactive approval.
- Raw CLI stdout parsing: duplicates SDK work and creates an undocumented protocol dependency.
- Direct model API: would reimplement the agent and violate the product boundary.

## Consequences

The extension may spawn a Qwen process per prompt and cannot share it with other clients. The UI/application architecture remains transport-neutral, so a daemon adapter can replace it later.

The SDK forwards child stderr only through debug-level logging. The adapter therefore captures that level into a bounded, secret-redacted diagnostic buffer while keeping routine debug messages out of normal output. This is an integration workaround around the supported SDK callback, not a patch to Qwen internals.
