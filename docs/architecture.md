# Architecture

## Dependency direction

```text
React webview / VS Code commands
              ↓ typed messages
        ChatController
        ↙           ↘
 AgentClient       ChangeManager
      ↓                 ↓
QwenCodeAgentClient  FileSystemPort
      ↓                 ↓
@qwen-code/sdk       VS Code APIs
      ↓
Qwen Code → configured provider
```

The domain and application layers never expose Qwen SDK messages to the webview. `QwenEventAdapter` validates and translates SDK messages into discriminated internal `AgentEvent` values.

## Components

- `AgentClient`: connection, one active run, cancellation, and event subscription boundary.
- `QwenCodeAgentClient`: owns SDK queries, permission callbacks, session resumption, and stderr diagnostics.
- `QwenEventAdapter`: converts streaming deltas, assistant blocks, tool calls/results, and result messages to domain events.
- `QwenSessionManager`: persists only the workspace session identifier; chat bodies and file content are not persisted.
- `ChatController`: application state machine, typed webview message dispatch, permissions, and coordination of agent events with change tracking.
- `PermissionManager`: stores pending approval promises and resolves or denies them, including cancellation cleanup.
- `ChangeManager`: maintains original/proposed content, hashes, counts, and state transitions independently of VS Code.
- `VsCodeFileSystem`: implements file reads, writes, deletes, dirty-document checks, and workspace-boundary validation.
- `DiffContentProvider`: exposes immutable `qwen-review:` original and proposed documents to the native diff editor.
- `ChatViewProvider`: CSP-protected host for the React UI and typed message bridge.
- `Configuration` and `Logger`: centralized settings and secret-conscious diagnostics.

## Event and state flow

1. The webview sends a validated `sendPrompt` intent.
2. The controller checks workspace trust, creates/resumes a session, marks the UI running, and invokes `AgentClient`.
3. SDK partial messages become assistant chunks. Tool blocks become structured read/search/edit/command/test activities.
4. Before a sensitive tool runs, the SDK permission callback emits a permission request. Dedicated edit targets are snapshotted before an allow response is returned.
5. When the tool completes, tracked targets are read again and become pending `ProposedFileChange` records.
6. The controller publishes a serializable view state. React only renders that state and sends user intentions.
7. Review opens two virtual documents in `vscode.diff`. Accept keeps the working-tree result after verification. Reject restores the base only after verification.

### Turn finality

Agent preamble, reasoning summaries, and structured tool events remain processing activity. An `agent.completed` event promotes only the matching terminal assistant message (or the explicit completion result) to a typed `finalResponse` timeline item. The webview groups activity and the final response by user turn, renders processing in a collapsible region, and always renders the final response outside that region. This typed boundary prevents presentation heuristics from hiding preamble text or treating arbitrary assistant chunks as final output.

### Token metrics

Token metrics remain three separate typed concepts:

- `MessageTokenCount` describes only visible user or final-response text. SDK 0.1.8 has no public message-only tokenizer, so the local UTF-8 heuristic is always marked `estimated` and rendered with `~`.
- `TurnTokenUsage` is Qwen's exact result-level cumulative input/output usage across the model calls in one agent turn. Assistant-call usage is aggregated only as a fallback when a result-level value is unavailable.
- `ContextTokenUsage` is the current session prompt/context returned by `Query.getContextUsage()`, including Qwen's effective context-window capacity. It is not derived from cumulative turn input and may decrease after Qwen compacts context.

`QwenCodeAgentClient` translates SDK usage into domain values before emitting it. `ChatController` associates context updates with the active session and keeps them outside the timeline. Starting a new session clears context immediately. The webview's context meter is state-only metadata; its updates do not create conversation entries or trigger the timeline auto-scroll key.

## UI states

The application state explicitly distinguishes `idle`, `connecting`, `connected`, `running`, `waitingForPermission`, `cancelling`, `failed`, and `completed`. File state distinguishes `pending`, `accepted`, `rejected`, and `conflicted`.

## Security

- Agent execution is blocked in untrusted workspaces.
- The webview uses `default-src 'none'`, a per-render script nonce, constrained local resource roots, and no HTML rendering of agent text.
- Webview messages are runtime validated.
- SDK stderr is sent to a dedicated output channel and never includes environment dumps. Debug output is opt-in.
- File targets are canonical workspace URIs and must remain inside an open workspace folder.
- Permission requests default to denial on timeout, cancellation, disposal, or malformed input.

## Qwen/provider boundary

The extension supplies only working directory, optional executable path, session ID, permissions, and streaming configuration. Authentication, base URL, model/provider selection (including LM Studio), tools, context, and reasoning remain Qwen Code responsibilities. Context capacity is reported by Qwen Code and is never hardcoded or queried directly from the model provider.
