# Architecture

## Dependency direction

```text
React webview / VS Code commands
              ↓ typed messages
        ChatController
   ↙          ↓             ↘
AgentClient  ModelManagement  ChangeManager
    ↓          ↓       ↓          ↓
QwenCode   Qwen settings  /models  FileSystemPort
AgentClient   + .env     probe         ↓
    ↓                              VS Code APIs
@qwen-code/sdk
      ↓
Qwen Code → configured provider
```

The domain and application layers never expose Qwen SDK messages to the webview. `QwenEventAdapter` validates and translates SDK messages into discriminated internal `AgentEvent` values.

## Components

- `AgentClient`: connection, one active run, cancellation, and event subscription boundary.
- `QwenCodeAgentClient`: owns SDK queries, permission callbacks, session resumption, and stderr diagnostics.
- `QwenEventAdapter`: converts streaming text/thinking blocks, assistant blocks, tool calls/results, and Qwen subagent parent IDs to domain events.
- `ContextUsageRefreshScheduler`: debounces boundary-driven context control requests and serializes them so `getContextUsage()` is never called concurrently.
- `QwenSessionManager`: persists only the workspace session identifier; chat bodies and file content are not persisted.
- `ChatController`: application state machine, typed webview message dispatch, permissions, and coordination of agent events with change tracking.
- `ModelManagementController`: native VS Code quick-pick/input flows for selecting, adding, editing, testing, and opening Qwen model configuration. Credential entry is a native password input and never enters webview state.
- `QwenSettingsService`: parses and enumerates the installed Qwen settings schema, preserves unknown fields, detects workspace overrides and concurrent edits, creates a one-time backup, and atomically replaces user settings and `.env` files.
- `OpenAICompatibleEndpointProbe`: bounded, explicit `GET <baseUrl>/models` diagnostics with optional bearer authentication. It is not used for prompts or tools.
- `PermissionManager`: stores pending approval promises and resolves or denies them, including cancellation cleanup.
- `ChangeManager`: maintains original/proposed content, hashes, counts, and state transitions independently of VS Code.
- `VsCodeFileSystem`: implements file reads, writes, deletes, dirty-document checks, and workspace-boundary validation.
- `DiffContentProvider`: exposes immutable `qwen-review:` original and proposed documents to the native diff editor.
- `ChatViewProvider`: CSP-protected host for the React UI and typed message bridge.
- `Configuration` and `Logger`: centralized settings and secret-conscious diagnostics.

## Event and state flow

1. The webview sends a validated `sendPrompt` intent.
2. The controller checks workspace trust, creates/resumes a session, marks the UI running, and invokes `AgentClient`.
3. SDK partial messages become separate assistant and thinking chunks. Tool blocks become structured read/search/edit/command/test/subagent activities. Qwen's `parent_tool_use_id` becomes a typed parent relationship so child thoughts and tools render under the owning Agent call.
4. Before a sensitive tool runs, the SDK permission callback emits a permission request. Dedicated edit targets are snapshotted before an allow response is returned.
5. When the tool completes, tracked targets are read again and become pending `ProposedFileChange` records.
6. The controller publishes a serializable view state. React only renders that state and sends user intentions.
7. Review opens two virtual documents in `vscode.diff`. Accept keeps the working-tree result after verification. Reject restores the base only after verification.

Qwen remains responsible for discovering and running subagents. The extension does not pass an `agents` override unless a future feature explicitly supplies one, and it does not create child queries. Foreground cancellation uses the parent SDK query's interrupt and abort semantics.

### Model selection flow

1. The webview renders only a secret-free active-model summary and sends `manageModels` when the header control is activated.
2. `ChatController` blocks the operation while an agent run or permission decision is active.
3. Native VS Code controls collect the selection and any provider details. The settings service writes Qwen's own user configuration, never a parallel application configuration.
4. A switch persists the provider auth type, model ID, and normalized base URL as one selection. The base URL disambiguates identical model IDs at different endpoints.
5. `ChatController` creates a fresh Qwen session and clears timeline/context state. The next normal prompt creates a new SDK query, which reloads Qwen's provider configuration.

### Turn finality

Agent preamble, reasoning summaries, and structured tool events remain processing activity. An `agent.completed` event promotes only the matching terminal assistant message (or the explicit completion result) to a typed `finalResponse` timeline item. The webview groups activity and the final response by user turn, renders processing in a collapsible region, and always renders the final response outside that region. This typed boundary prevents presentation heuristics from hiding preamble text or treating arbitrary assistant chunks as final output.

### Token metrics

Token metrics remain three separate typed concepts:

- `MessageTokenCount` describes only visible user or final-response text. SDK 0.1.8 has no public message-only tokenizer, so the local UTF-8 heuristic is always marked `estimated` and rendered with `~`.
- `TurnTokenUsage` is Qwen's exact cumulative input/output usage across model calls in one agent turn. Completed assistant-call usage is deduplicated and published progressively; result-level usage replaces it when available.
- `ContextTokenUsage` is the current session prompt/context returned by `Query.getContextUsage()`, including Qwen's effective context-window capacity. It is not derived from cumulative turn input and may decrease after Qwen compacts context.

`QwenCodeAgentClient` translates SDK usage into domain values before emitting it. `ChatController` associates context updates with the active session and keeps them outside the timeline, while one typed turn-usage item is updated in place for Processing. Starting a new session clears context immediately. No activity receives a token count unless Qwen provides authoritative attribution.

### Presentation state and scrolling

Processing expansion uses `automatic`, `user-expanded`, and `user-collapsed` preferences. Automatic state may open a new/failed/waiting turn and collapse a completed turn, but permission, failure, tool, thought, and subagent events never overwrite an explicit preference. Approval cards are siblings of the conversation turns and stay visible when Processing is collapsed.

The webview keeps an explicit follow-latest state based on distance from the document bottom. A `ResizeObserver` catches streaming Markdown, disclosure, token, permission, and nested-agent layout changes; coalesced animation-frame scrolling anchors the document only while follow mode is active. A manual scroll away disables it, returning near the bottom or choosing **Jump to latest** re-enables it. The streaming path does not call `scrollIntoView()`.

## UI states

The application state explicitly distinguishes `idle`, `connecting`, `connected`, `running`, `waitingForPermission`, `cancelling`, `failed`, and `completed`. File state distinguishes `pending`, `accepted`, `rejected`, and `conflicted`.

## Security

- Agent execution is blocked in untrusted workspaces.
- The webview uses `default-src 'none'`, a per-render script nonce, constrained local resource roots, and no HTML rendering of agent text.
- Webview messages are runtime validated.
- SDK stderr is sent to a dedicated output channel and never includes environment dumps. Debug output is opt-in.
- File targets are canonical workspace URIs and must remain inside an open workspace folder.
- Permission requests default to denial on timeout, cancellation, disposal, or malformed input.
- API tokens are accepted only by a native password input, stored in Qwen's `.env` through a generated `envKey`, and excluded from webview contracts and diagnostics.
- Invalid JSON, project overrides, and concurrent settings or `.env` changes stop the write. Existing files receive a one-time `.konnits-backup`, and replacements use a same-directory temporary file plus rename.

## Qwen/provider boundary

Qwen remains the owner and runtime consumer of authentication, base URL, model/provider selection (including LM Studio), tools, context, and reasoning. Konnits-Coder provides a safe editor for that Qwen-owned configuration. It never sends a normal prompt directly to a provider. The only direct provider request is the user-initiated OpenAI-compatible model-list probe. Context capacity is reported by Qwen Code and is never inferred from that probe.
