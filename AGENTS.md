# AGENTS.md

## Purpose

This repository implements a Visual Studio Code frontend for Qwen Code.

The extension is responsible for:

- VS Code integration
- chat UI
- agent activity visualization
- session UX
- file-change tracking
- native diff review
- change acceptance/rejection
- command/test visualization
- connection management

Qwen Code is responsible for the actual coding-agent behavior.

This repository must NOT reimplement a coding agent or directly duplicate Qwen Code functionality unless there is a clear technical reason.


# Core Architecture

The intended dependency direction is:

VS Code / Webview UI
        ↓
Application Controllers
        ↓
AgentClient abstraction
        ↓
QwenCodeAgentClient
        ↓
Qwen Code SDK / daemon
        ↓
Qwen Code
        ↓
Configured model provider

The initial model provider is expected to be LM Studio serving a local Qwen model, but the extension must remain model-provider agnostic.


# Fundamental Rule

Do not couple UI components directly to Qwen Code SDK objects.

Raw Qwen events must be translated into internal domain events.

The UI must consume internal domain models.


# Agent Abstraction

Prefer an abstraction similar to:

AgentClient

with a Qwen implementation:

QwenCodeAgentClient

The rest of the application should not need to know how Qwen Code communicates internally.


# Domain Events

Normalize agent behavior into explicit internal events.

Examples:

AgentStarted
AgentStopped

AssistantMessageStarted
AssistantMessageChunk
AssistantMessageCompleted

ToolStarted
ToolCompleted
ToolFailed

FileRead
FileSearch
FileChangeProposed

CommandStarted
CommandOutput
CommandCompleted

TestStarted
TestCompleted

PermissionRequested

SessionCreated
SessionResumed
SessionEnded

Do not pass unstructured arbitrary JSON through the whole application.


# Change Review Is Critical

File change review is one of the central features of this repository.

The user must be able to:

- inspect changes
- review changes using the native VS Code diff editor
- accept an individual file
- reject an individual file
- accept all
- reject all

Never implement reject behavior in a way that risks silently destroying user edits.

Agent-generated changes and user-generated changes must be distinguished whenever possible.

If the file changed independently after the agent produced a proposal, detect the conflict and avoid destructive restoration.


# Native VS Code Features

Prefer native VS Code APIs for editor-related functionality.

For file comparison, prefer the native diff editor.

For proposed virtual content, prefer a TextDocumentContentProvider or the current equivalent public VS Code API.

Do not recreate a source-code diff editor in HTML unless the native VS Code API cannot satisfy the requirement.

Do not rely on private or undocumented GitHub Copilot APIs.


# Webview

The conversational UI may use a webview.

Webviews must:

- use a restrictive Content Security Policy
- avoid eval
- sanitize untrusted rendered content
- communicate with the extension host through typed messages
- avoid direct filesystem access
- avoid direct Qwen SDK access
- keep presentation logic separate from domain/application logic


# TypeScript

Use strict TypeScript.

Prefer:

- precise interfaces
- discriminated unions
- readonly state where useful
- explicit types at module boundaries
- narrow interfaces

Avoid excessive use of:

any

If interaction with an external library requires unknown data, prefer:

unknown

followed by explicit validation.


# Module Design

Keep modules focused.

Avoid putting significant logic in:

src/extension.ts

The extension entry point should primarily:

- initialize services
- register commands
- register providers
- connect lifecycle hooks
- dispose resources

Business logic belongs in dedicated modules.


# Dependency Direction

UI may depend on application/domain abstractions.

Application code may depend on domain abstractions.

Qwen adapter code may depend on the Qwen SDK.

Domain code must not depend on:

- React
- Webview APIs
- Qwen SDK
- filesystem implementation details where avoidable


# External APIs

Never invent APIs.

Before using an unfamiliar API:

1. inspect the installed package
2. inspect official documentation
3. inspect TypeScript declarations
4. confirm behavior

This is especially important for:

- Qwen Code SDK
- qwen daemon
- qwen serve
- VS Code proposed APIs

Avoid proposed VS Code APIs unless absolutely necessary.

Prefer stable public APIs.


# Qwen Code

Treat Qwen Code as an external system.

All Qwen-specific behavior should be isolated under an appropriate adapter/integration module.

Handle:

- connection
- disconnection
- cancellation
- streaming
- malformed/unexpected events
- daemon termination
- session lifecycle

Do not assume Qwen Code is installed globally.

Provide actionable errors when it is unavailable.


# Daemon Process Management

If the extension starts a Qwen daemon:

- remember that this extension owns that process
- monitor the process
- capture useful diagnostics
- stop only the process started by this extension
- do not kill arbitrary existing Qwen processes

If connecting to an existing daemon, do not assume process ownership.


# Model Provider

The extension should not directly depend on LM Studio.

Model/provider configuration should preferably remain the responsibility of Qwen Code.

Initial development environment:

LM Studio:
http://localhost:1234/v1

Initial model:
Qwen3.6-35B-A3B

These values are development defaults/context, not architecture assumptions.


# Workspace Trust

Respect VS Code Workspace Trust.

Do not automatically perform dangerous actions in untrusted workspaces.

Follow current VS Code guidance for:

- process execution
- filesystem writes
- external commands


# Shell Commands

Shell commands executed by Qwen must be visible in the UI or diagnostics.

Potentially destructive operations require special care.

Never automatically normalize dangerous behavior merely because the model requested it.

Examples requiring caution:

- rm -rf
- Remove-Item -Recurse on broad paths
- git reset --hard
- git clean -fd
- deleting files outside the workspace
- rewriting repository history


# Git

Do not use destructive Git commands to simplify implementation.

Do not assume the working tree is clean.

The user may have uncommitted changes unrelated to the agent.

Never run:

git reset --hard

or equivalent destructive restoration as part of normal change rejection.

Do not discard unrelated user work.


# Testing Philosophy

Tests are mandatory for meaningful behavior.

The normal automated test suite must not require:

- LM Studio
- a GPU
- a running local LLM
- internet access

Use fakes/mocks around Qwen integration.

Real Qwen/LM Studio integration may have a separate optional E2E test suite.


# Required Tests

Prioritize tests for:

- event adaptation
- state transitions
- change tracking
- accept behavior
- reject behavior
- reject-all behavior
- conflict detection
- session management
- connection errors
- configuration validation

Critical state-management logic must not rely only on manual testing.


# Development Workflow

For every task, follow this exact general workflow.

## 1. Understand

Read the full user request.

Determine:

- expected behavior
- affected components
- constraints
- likely risks


## 2. Inspect

Inspect the relevant code before editing.

Do not modify files based solely on filenames or assumptions.


## 3. Plan

Create a concise implementation plan.

For non-trivial work, identify:

- files/modules involved
- data-flow changes
- tests required
- compatibility concerns


## 4. Validate Assumptions

Confirm external APIs and existing repository behavior before implementation.

Do not fabricate method names or configuration properties.


## 5. Implement

Implement the smallest coherent solution.

Avoid unrelated refactors.


## 6. Compile / Typecheck

Run the project's type checking or build command.


## 7. Lint / Format

Run relevant linting/formatting checks.


## 8. Test

Run the tests relevant to the change.

When practical, run the broader test suite afterward.


## 9. Diagnose Failure

If any command or test fails:

DO NOT immediately patch randomly.

First determine:

- what failed
- why it failed
- whether the failure is caused by the new change
- whether the test assumption is correct


## 10. Fix

Modify the implementation based on the diagnosed root cause.


## 11. Retest

Run the failing test again.

Then run related tests.


## 12. Repeat

Continue:

analyze
→ modify
→ test

until the implementation is validated.


## 13. Review

Review the final diff.

Check for:

- accidental changes
- duplicated code
- unnecessary complexity
- inconsistent naming
- missing error handling
- missing tests


## 14. Document

Update documentation when behavior or architecture has materially changed.


# Do Not Claim Success Without Evidence

Never say a task is complete simply because code was written.

A task is considered validated only when the relevant available checks have been executed successfully.

If a check cannot be executed, state clearly:

- which check was not run
- why
- what remains unverified


# No Fake Testing

Do not claim:

"tests should pass"

as equivalent to running tests.

Run them when the environment allows it.


# Incremental Development

Prefer small milestones.

The repository should remain usable after each milestone.

Do not build the entire extension in one giant change.


# Error Handling

Errors should help the user understand what happened.

Prefer:

Unable to connect to Qwen Code at http://127.0.0.1:4170.

over:

Connection failed.

Include useful remediation when known.


# Logging

Use a VS Code OutputChannel for technical diagnostics.

Suggested channel:

Qwen Frontend

Logs may contain:

- extension startup
- daemon startup
- connection lifecycle
- session IDs where safe
- event types
- timing
- errors
- stack traces in debug mode

Logs must never contain:

- API keys
- tokens
- passwords
- complete environment dumps


# User-Facing UI

Normal users should see concise agent activity.

Prefer:

● Read
  src/auth.ts

● Search
  getCurrentUser

● Edited
  src/auth.ts
  +12 -4

● Terminal
  npm test

✓ Tests
  24 passed

Avoid showing raw protocol data in the main chat.


# UI State

The UI must make the following states distinguishable:

- idle
- connecting
- connected
- running
- waiting for permission
- cancelling
- failed
- completed

For file changes:

- pending
- accepted
- rejected
- conflicted


# Cancellation

Long-running agent operations must support cancellation where the underlying Qwen integration allows it.

Cancellation must propagate through the appropriate abstraction rather than merely hiding UI output.


# Sessions

Keep session behavior isolated from rendering.

A workspace may have one or more Qwen sessions.

Do not couple React component lifecycle directly to agent session lifecycle.


# Configuration

Configuration access should be centralized.

Do not scatter calls to:

vscode.workspace.getConfiguration(...)

through unrelated modules.

Use a configuration service or helper.


# React

React components should primarily render state and dispatch user intentions.

Avoid embedding agent protocol logic in React components.

Bad:

ChatMessage.tsx directly parses Qwen daemon packets.

Good:

QwenEventAdapter
    ↓
domain event
    ↓
state/controller
    ↓
ChatMessage.tsx


# Communication Between Extension and Webview

Use explicit typed message contracts.

Validate incoming webview messages.

Do not blindly trust arbitrary message objects from the webview.


# File Changes

Maintain clear ownership of original and proposed content.

A proposed change should contain enough information to make review deterministic.

Where practical store:

- file URI
- base/original content
- proposed/current content
- timestamps or versions
- status
- additions
- deletions

Consider using content hashes or VS Code document versions for conflict detection.


# Conflict Detection

Before rejecting or applying changes, determine whether the underlying file has changed since the proposal was recorded.

If there is a conflict:

- do not overwrite silently
- mark the change as conflicted
- inform the user
- provide a safe review path


# Persistence

Persist only what is useful across VS Code reloads.

Potentially useful:

- session identifiers
- UI preferences
- known daemon URL

Be conservative about persisting:

- full file contents
- large chat histories
- sensitive workspace data


# Performance

Do not copy entire repositories into the webview.

Do not continuously recompute large diffs unnecessarily.

Use incremental events.

Keep heavy filesystem or process work outside the UI rendering path.


# Documentation

Keep these documents current:

docs/architecture.md
docs/roadmap.md
docs/research.md
docs/change-review-design.md

Use ADRs under:

docs/decisions/

for important architectural choices.


# Architectural Decision Records

Create an ADR when a decision:

- significantly affects architecture
- is difficult to reverse
- has multiple reasonable alternatives
- impacts data safety
- impacts Qwen integration

An ADR should contain:

Context
Decision
Alternatives
Consequences


# Dependency Policy

Do not add a package merely to avoid implementing a trivial function.

Before adding a dependency, consider:

- maintenance status
- bundle size
- security
- necessity
- compatibility with VS Code extension host/webviews

Avoid large frameworks in the extension host.


# Security

Never expose Node APIs directly to the webview.

Never interpolate untrusted text into executable JavaScript.

Use CSP nonces or the currently recommended VS Code webview CSP mechanism.

Sanitize rendered Markdown/HTML.


# Compatibility

Do not depend on undocumented implementation details of:

- VS Code
- GitHub Copilot
- LM Studio
- Qwen Code

Prefer stable contracts.


# Scope Discipline

Do not introduce unrelated features while implementing a task.

If you discover a useful future improvement, document it in the roadmap rather than expanding the current task unnecessarily.


# Comments

Comments should explain:

- why something exists
- non-obvious constraints
- external API quirks
- data-safety considerations

Do not add comments that merely restate obvious code.


# Naming

Use clear names such as:

QwenCodeAgentClient
QwenDaemonManager
QwenEventAdapter
ChangeManager
DiffContentProvider
ChangeConflictDetector
SessionManager

Avoid vague names such as:

Manager2
Helper
Utils2
Thing
DataHandler

Generic utility modules should remain small and focused.


# Implementation Priorities

When forced to choose, prioritize in this order:

1. user data safety
2. correctness
3. testability
4. maintainability
5. clear UX
6. performance
7. cosmetic polish


# MVP Priorities

The initial MVP should focus on:

1. VS Code extension initialization
2. Qwen Code connectivity
3. streaming chat
4. structured tool activity
5. file change detection
6. native VS Code diff review
7. per-file accept/reject
8. accept all/reject all
9. command/test status
10. error handling


# Not MVP

Unless specifically requested, do not prioritize:

- marketplace publication
- telemetry services
- user accounts
- multiple agent backends
- custom Git implementation
- custom diff renderer
- cloud infrastructure
- collaboration features
- voice
- image generation
- mobile interfaces


# Definition of Done

A development task is done when:

- requirements are implemented
- code compiles/typechecks
- relevant lint checks pass
- relevant automated tests pass
- failures have been investigated
- final diff has been reviewed
- user data safety has been considered
- documentation is updated when necessary

If any of these cannot be completed, clearly state the limitation.


# Final Response After Coding Tasks

At the end of a coding task, provide a concise summary containing:

1. What changed
2. Important architectural decisions
3. Tests/checks executed
4. Their results
5. Any known limitation or remaining work

Do not provide a vague summary.

Use concrete filenames and test results.