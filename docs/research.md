# API research

Research date: 2026-08-17. Only stable public VS Code APIs, the installed SDK declarations/bundle, and official Qwen Code documentation were used.

## Qwen Code

The supported programmatic surface is [`@qwen-code/sdk`](https://qwenlm.github.io/qwen-code-docs/en/developers/sdk-typescript/). Version 0.1.8 was inspected from npm, including its shipped TypeScript declarations.

Confirmed SDK behavior:

- `query({ prompt, options })` returns an async iterable `Query`.
- `includePartialMessages: true` emits `stream_event` messages with text/thinking deltas.
- completed assistant messages contain typed `text`, `thinking`, `tool_use`, and `tool_result` content blocks.
- `Query.interrupt()` and an `AbortController` provide cancellation.
- `sessionId` creates a caller-chosen session and `resume` resumes it on a later query.
- `permissionMode: "default"` permits read-only tools and calls `canUseTool` for writes/commands; absent approval is fail-closed.
- The installed SDK also declares `plan`, `auto-edit`, `auto`, and `yolo`.
  Inspection of the bundled permission path confirmed that automatic modes can
  authorize tools without invoking `canUseTool`; `plan` blocks non-read-only
  tools and `yolo` auto-approves every tool before the callback. Konnits exposes
  `yolo` only behind an explicit, per-workspace risk acknowledgement. Until it
  is acknowledged, a configured `yolo` value is interpreted as `default`.
- Public `SDKUserMessage` input accepts text and the SDK's declared content
  blocks but has no public image-input block. The installed Qwen CLI's native
  `@` preprocessor does accept file/image paths within the workspace context.
  Controlled attachment copies are consequently supplied as `@` references
  with their storage root included in `QueryOptions.includeDirectories`, rather
  than inventing an unsupported SDK payload.
- Direct `Query` exposes resume/fork but no public rewind method. SDK 0.1.8's
  public `DaemonClient` exposes `loadSession`, `getRewindSnapshots`, and
  `rewindSession(sessionId, promptId, { rewindFiles })`. The installed daemon
  implementation truncates model history before the selected user turn and
  records a rewind branch in Qwen's transcript. Konnits uses this route with
  `rewindFiles: false`; Qwen's own file-history restoration is not used because
  it does not enforce the extension's dirty-document and proposal-hash checks.
- `pathToQwenExecutable` is optional in the 0.1.8 declarations because the package includes a bundled CLI. It can still target an explicit installed Qwen executable.
- The SDK and current Qwen Code require Node.js 22 or newer.
- `Query.supportedCommands()` is a public control API. With the installed
  bundle it returned `{ subtype: "supported_commands", commands: [...] }` and
  did not invoke the model when called on an SDK query with an idle input
  stream.
- The installed SDK's command response contains names only for this runtime;
  descriptions and source labels are not consistently exposed. Konnits uses a
  neutral runtime-reported description when metadata is absent rather than
  maintaining a duplicate built-in catalog. Runtime names remain authoritative.
- The installed SDK does not export a public command-registry enumeration
  beyond `supportedCommands()`. Project and user Markdown/TOML command files
  under `.qwen/commands/` and `~/.qwen/commands/` are inspected for
  presentation frontmatter. Project metadata wins over user metadata, matching
  Qwen's documented precedence. Unknown future runtime commands remain usable.

The installed versions were checked directly:

- `@qwen-code/sdk`: 0.1.8
- SDK-bundled CLI: 0.19.10
- global `qwen`: 0.21.12; it is not used unless the executable override is configured

The current official [Qwen commands documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/)
documents `/` slash commands, `@` file/directory injection, escaped spaces,
and project-over-user custom-command precedence. The official documentation
also describes headless `/diff` as plain text rather than an interactive picker.

### Slash command runtime validation

The installed bundled CLI returned these supported command names through the
public SDK control request during validation: `auth`, `bug`, `clear`,
`compress`, `compress-fast`, `config`, `context`, `diff`, `docs`, `doctor`,
`effort`, `export`, `extensions`, `goal`, `hooks`, `import-config`, `init`,
`insight`, `language`, `model`, `stats`, `status`, `summary`, `tasks`, and
`update`. This list is recorded as research evidence only; it is not copied
into application code.

Direct SDK/headless command checks using the same bundled CLI produced:

- `/context`: success with context usage text.
- `/model`: success with current-model text and argument help.
- `/help` and `/agents`: unsupported through the non-interactive command path.
  Konnits now intercepts both with native adapters before starting an SDK turn.

Konnits sends dynamically reported, supported slash commands unchanged through
`QwenCodeAgentClient`. `/help` is generated from the unified registry;
`/agents` and `/agents list` show the same daemon-discovered definitions used
for `QueryOptions.agents`. Unknown commands and the explicitly known
interactive-only `/editor` fail locally without creating a Qwen turn.

### Session history runtime validation

The installed bundled CLI exposes `qwen sessions list --json --limit N` as
JSON Lines. Each entry includes the session ID, prompt/title data, update
time, workspace cwd, and exact transcript path. `QwenSessionHistoryService`
uses that command rather than scanning arbitrary directories, filters the
result against canonical open workspace roots, and sorts by Qwen's mtime.

Historical transcripts are Qwen JSONL records. The extension maps user text,
assistant text, thinking, function calls, tool results, and recorded usage into
the existing internal timeline. It ignores telemetry/system records and never
replays a historical tool call. Selecting a history item first loads this
display transcript, then uses an SDK query with `resume` and an empty async
input stream to reattach and read context usage without inference.

A disposable live integration test confirmed that two real Qwen sessions in a
temporary workspace can be listed, restored into the internal timeline,
continued with the original model context, cleared while preserving the marked
current session, and deleted completely. SDK 0.1.8 can briefly retain Qwen's
global extension-store lock after an idle restore query closes; its transport
uses a five-second forced-shutdown boundary. `QwenCodeAgentClient` recognizes
that exact transient error and retries once after the shutdown window without
changing the requested resume/session ID semantics.

Deletion follows the installed Qwen session service behavior: the validated
UUID-named active/archive transcript, matching worktree sidecars, exact
`file-history/<sessionId>` directory, and that session's organization entry
are removed. The first transcript record must match both the selected session
ID and workspace before deletion proceeds. The current session is not offered
for deletion from the picker.

### Native `@` validation

The installed CLI source contains the `@` preprocessor in its SDK input path:
it parses escaped path tokens, checks workspace boundaries and ignore rules,
resolves files/directories, invokes Qwen's multi-file reader, and appends the
resulting content parts before model generation. Konnits therefore does not
read or inject file contents itself.

Live SDK checks through the bundled 0.19.10 CLI succeeded:

- `@package.json dime cuál es el nombre del proyecto y menciona dos dependencias.`
  returned the project name `konnits-coder` and dependencies based on the file.
- `@src/ resume la estructura de este directorio en tres puntos.` returned a
  directory summary based on `src/`.

The serializer normalizes Windows separators to `/` and escapes Qwen's shell
special path characters, including spaces (`@My\\ Documents/file.txt`).
Non-primary multi-root references use an absolute file URI path because the
current Konnits query uses the first workspace as `cwd`; all additional roots
are passed through SDK `includeDirectories`. This keeps display paths relative
while giving Qwen an unambiguous path for separate roots.

Autocomplete uses metadata only. It is bounded to 40 visible workspace
candidates, excludes common generated/binary locations, and does not transmit
file contents. The current implementation refreshes command discovery on the
first `/` menu request; it does not watch global custom-command directories.

### Thinking and partial-message correlation

The installed SDK declares `ThinkingBlock` separately from `TextBlock` and emits `thinking_delta` from `SDKPartialAssistantMessage` when `includePartialMessages` is enabled. The bundled CLI implementation was also inspected: it emits `content_block_start`, `thinking_delta`, `content_block_stop`, a completed assistant message, and `message_stop`. Partial envelope UUIDs are newly generated for every event and therefore are not correlation IDs. The stable stream scope is `parent_tool_use_id` (or the single main stream), while `message_start.message.id` matches the completed assistant message UUID.

Konnits-Coder renders only these typed Qwen thinking blocks. It does not infer thoughts from ordinary assistant text. Qwen does not expose a duration field in this SDK, so the UI's thought duration is explicitly a local wall-clock measure between the first and final block events. No authoritative per-thought token attribution is exposed.

### Qwen-managed subagents

The current official [Agent tool documentation](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/task/) and [subagent documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/) describe Qwen-owned discovery, foreground/background execution, live progress, and project/user agent configuration. The installed SDK exposes `agents` for programmatically supplied definitions. SDK mode intentionally limits `SubagentManager` to session definitions, so Konnits-Coder starts the selected runtime's own temporary daemon, reads its public `/workspace/agents` definitions, and supplies them as `QueryOptions.agents`. This preserves Qwen's discovery, built-ins, precedence, and validation without executing agent files in the extension or passing an empty array on discovery failure.

SDK 0.1.8 declarations also expose public daemon create, update, and delete
methods. They were investigated but are not advertised in this change: a safe
management UX still needs scope selection for shadowed project/user agents,
field validation, built-in read-only handling, confirmation, and coordinated
cache invalidation. `/agents create|edit|delete` therefore returns an explicit
local limitation instead of pretending that CRUD is available.

On Windows, spawning the `.mjs` daemon bootstrap as an executable fails with
`spawn EFTYPE`. The Extension Host path now invokes `process.execPath` with
`ELECTRON_RUN_AS_NODE=1` and the bootstrap as its first argument; the bootstrap
then launches the selected Qwen CLI under external Node. A live regression test
uses this exact branch and confirms that the daemon returns real agents.

The direct SDK query has no `coreTools` or `excludeTools` restriction, so `agent` remains model-visible. The bundled stream adapter emits child assistant/tool/result events with the owning Agent tool call in `parent_tool_use_id`; Konnits-Coder preserves that relationship. Both `agent` and the older SDK declaration's `task` spelling are recognized for presentation. `Query.interrupt()` plus the query `AbortController` remain the only cancellation mechanism; the bundled Agent invocation propagates its abort signal to foreground children.

The public `CanUseTool` options in SDK 0.1.8 expose `signal` and suggestions, but not a tool-use ID or parent agent ID. Subagent-originated approval requests remain actionable through the same callback, but Konnits-Coder cannot label their origin authoritatively with this SDK version. It does not guess.

A live Konnits-Coder SDK run on 2026-08-15 emitted a root `agent` start for both `general-purpose` and `Explore`, child read/search/list tool events carrying that Agent call as `parentId`, successful Agent completion, and a later parent continuation. The direct CLI and SDK use the same Qwen runtime/provider path; the extension preserves the public parent relationship in its typed activity tree.

### Token and context usage

The installed 0.1.8 declarations and implementation expose three relevant public values:

- every completed assistant API message has `message.usage` for that model call;
- every SDK result has aggregate `usage` for the complete agent turn;
- `Query.getContextUsage(showDetails?)` sends the typed `get_context_usage` control request and returns the current session context data.

The bundled CLI 0.19.10 response was inspected. It includes `totalTokens`, `contextWindowSize`, `modelName`, and `isEstimated`. `totalTokens` is the content generator's last prompt token count, while `contextWindowSize` comes from Qwen's effective generation configuration (falling back inside Qwen itself). The extension therefore does not hardcode a capacity or contact LM Studio directly.

A live SDK probe against the configured local Qwen model confirmed the distinction. One simple turn reported 39,023 cumulative input tokens and 196 output tokens at result level, while current context was 23,173 of 262,144 tokens. The current-context value matched the last model prompt rather than the result's cumulative input. Context is consequently stored independently and lower later values are accepted as valid compaction.

With a single-string SDK prompt, the transport closes input as soon as the result is routed, leaving no reliable control-request or active-turn message window. The installed SDK's public `query()` declaration accepts `AsyncIterable<SDKUserMessage>` and its `Query` documentation describes multi-turn streaming input. The extension therefore owns a controlled input queue for the active query: it yields the initial prompt, accepts additional user messages while the run is active, keeps the stream open through context refresh, and closes it at the result boundary. This changes transport lifetime only; one Konnits conversation turn still owns one SDK query. Context-control failures are caught and do not change a successful agent result into a failed turn.

Context refreshes are now scheduled at query initialization and useful typed boundaries (assistant completion, thought completion, tool start/result, and final result). A 500 ms debounce coalesces adjacent boundaries and the scheduler never overlaps `getContextUsage()` control requests. Mid-request values are published exactly as returned; stale values are accepted rather than interpolated. Completed assistant `message.usage` values are deduplicated by assistant UUID and accumulated progressively. The final result usage, when present, replaces the progressive aggregate as the authoritative turn total.

The public protocol does not attribute provider input/output usage to a specific tool or thought. Child assistant calls may contribute to aggregate turn usage, but SDK 0.1.8 does not provide a safe per-subagent breakdown in its public message contract. Individual activity rows consequently have no token badge; the Processing header shows only authoritative cumulative turn usage.

No public SDK API tokenizes an arbitrary visible message independently of hidden instructions, tool traffic, or the complete model turn. Visible user and final-response counts therefore use a model-independent UTF-8 byte heuristic and are explicitly marked `~`; they must not be described as Qwen tokenizer results.

### Windows LM Studio failure investigation

The failing execution path was reproduced independently of VS Code on Windows 11. The installed package versions were:

- `@qwen-code/sdk`: 0.1.8
- SDK-bundled Qwen CLI: 0.19.10
- global CLI: 0.21.12 at `C:\Users\geral\AppData\Local\qwen-code\bin\qwen.cmd`; the extension still uses the SDK-bundled 0.19.10 CLI by default unless its executable override is configured

The Extension Host reproduction identified a separate Windows/Electron launch defect. SDK 0.1.8 resolves a JavaScript CLI to `{ command: process.execPath, args: [cliPath] }`. In a normal Node process this is correct; in a VS Code Extension Host, `process.execPath` is `Code.exe`. The child Qwen 0.19.10 process then treated its own `cli.js` path as the initial positional prompt before the SDK wrote the real user frame. The persisted Qwen session contained the CLI path as its first user record, while SDK diagnostics contained only the `initialize` control write and no user write.

The compatibility fix is limited to JavaScript CLIs on Windows Electron hosts. `dist/qwen-cli-launcher.mjs` bridges stdin/stdout/stderr and signals while launching the same resolved Qwen CLI under external Node.js. A real Electron-host validation then observed the exact user frame, no CLI path in user content, tool results followed by model continuation, and one final SDK result. Native/configured commands are unchanged.

Inspection of the installed SDK implementation confirmed:

- an omitted `pathToQwenExecutable` resolves to `@qwen-code/sdk/dist/cli/cli.js` and launches it with the current Node executable;
- command names and explicit JavaScript/native paths are supported through `pathToQwenExecutable`;
- the child environment is `{ ...process.env, ...options.env }`;
- providing `stderr` changes child stderr to a pipe, but the SDK forwards raw child stderr through its debug logger, so `logLevel: "error"` suppresses the useful child message even though a callback exists;
- nonzero CLI exit status is reduced to `CLI process exited with code N`, which explains the original unhelpful OutputChannel entry.

The extension's exact fresh-session SDK options completed a real authenticated request to LM Studio and returned the expected text using bundled CLI 0.19.10. A direct bundled-CLI request also succeeded. The settings-v4 provider model and authenticated OpenAI-compatible path are therefore compatible with this bundle in the current environment; the 0.19.10/0.21.12 version gap did not cause the observed exit.

The actual exit was session lifecycle state. `QwenSessionManager` persisted a randomly generated session ID before Qwen completed its first run. The **New Session** flow then treated that in-memory ID as resumable immediately, so its first prompt deterministically used SDK `resume` for a session Qwen had never created. An initial failed run produced the same poisoned state for later prompts. Qwen printed `No saved session found with ID ...` and immediately exited 1. Running the same SDK request with an intentionally nonexistent resume ID reproduced the exact failure.

New sessions are now marked unestablished and use SDK `sessionId` until a successful agent completion; only then are they persisted as established/resumable. Konnits-Coder also captures the redacted child diagnostic and retries exactly the missing-session condition once with `sessionId`. That fallback repairs legacy stored IDs and interrupted first runs. Other failures are not retried or hidden.

Runtime diagnostics now record the SDK version, CLI source/path/version, settings path, workspace, provider, model, base URL, and credential presence/source. The SDK logger remains at debug internally so child stderr can be captured; routine debug output is written only when `qwenFrontend.debug` is enabled, while a bounded relevant summary is logged for failures. SDK stdin diagnostics are discarded because they can include the user's prompt. Known credential values loaded from Qwen settings plus common authorization/API-key formats are redacted before logging.

### Authentication and generation configuration

The installed CLI source calls `loadEnvironment(settings.merged)`. That function copies allowed string entries from `settings.env` into the Qwen child's `process.env` when no process value already exists. Provider resolution then reads `process.env[modelProviders[provider][].envKey]`. This was tested with the credential absent from the parent extension environment: both the SDK request and direct CLI request authenticated successfully. A separate bearer-authenticated `GET /v1/models` returned successfully and listed `qwen3.6-35b-a3b`; no credential value was printed.

The installed schema and the official [Qwen settings reference](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md) define `maxRetries` and `contextWindowSize` as direct `generationConfig` fields. The official [model provider reference](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md) reserves `extra_body` for additional OpenAI-compatible request-body parameters. The user's configuration was migrated accordingly: `enable_thinking` remains in `extra_body`, while `maxRetries` and `contextWindowSize` are siblings of it. This placement issue did not cause the session exit, but leaving it unchanged would send Qwen client controls to LM Studio as arbitrary body fields instead of applying them inside Qwen.

### Model management and settings precedence

The bundled CLI source, schema, declarations, and `/model` implementation were inspected before implementing model management:

- `Storage.getGlobalQwenDir()` resolves non-empty `QWEN_HOME` first, otherwise the platform home plus `.qwen`; user settings are `settings.json` in that directory.
- Bundled CLI 0.19.10 uses settings version 4 and defines `modelProviders` as a replace-merged object whose values are model arrays keyed by auth type. Its OpenAI-compatible entry fields include `id`, optional `name`, `baseUrl`, `envKey`, and `generationConfig`.
- `/model` persists `model.name`, `model.baseUrl`, and `security.auth.selectedType`. Within one auth type, `id + baseUrl` is the effective identity, so the same model ID can safely appear at multiple endpoints.
- Trusted workspace `.qwen/settings.json` replaces user `modelProviders` when it owns that property. Konnits-Coder detects this scope and refuses automatic project writes, offering to open the workspace file instead.
- The installed environment loader supports the global Qwen `.env` path and resolves process environment before `.env`, with `settings.env` as a lower-priority legacy fallback. New Konnits-Coder credentials therefore use `.env`; existing sources are detected without migration.
- Reasoning is represented as `false` or an effort object, while `contextWindowSize` is a direct `generationConfig` field. Edits preserve every unknown provider and generation field.

The current official [model-provider documentation](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/) now describes a newer `{ protocol, models }` provider container. That shape does not match the repository's pinned SDK-bundled CLI, whose running schema and `/model` code still require arrays. The extension deliberately targets the installed runtime and fails closed if `modelProviders.openai` has a non-array shape; upgrading the SDK requires reviewing this adapter and its tests.

There is no public SDK settings mutation API appropriate for the direct-query integration. Deep-importing CLI configuration internals would couple the extension to generated private chunks. `QwenSettingsService` therefore performs a narrow read/modify/write of Qwen's file: invalid JSON is never overwritten, unrelated values and unknown model fields survive, the initial file is backed up once, concurrent changes are detected from the exact loaded contents, and a same-directory temporary file is renamed over the target.

Endpoint discovery follows the OpenAI-compatible contract with a bounded `GET <baseUrl>/models` and optional bearer token. It validates connectivity, authentication, response shape, discovered IDs, and a requested-ID mismatch. This request is diagnostic only. All chat and tool traffic continues through `QwenCodeAgentClient` and Qwen Code.

The public SDK exposes `Query.setModel`, but changing a live query would retain model-specific conversation state and creates unclear provider reload behavior. Konnits-Coder disables switching during active work, persists the Qwen selection, then creates a new session. This makes the next SDK query load the selected provider and clears stale context metrics and transcript state.

The official [filesystem tool reference](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/file-system/) confirms dedicated edit tools and their path fields: `edit.file_path`, `write_file.file_path`, and `notebook_edit.file_path`. The official [shell reference](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/shell/) identifies `run_shell_command` input and warns that command-pattern restrictions are not a security boundary.

Qwen's own prompt asks the agent to use dedicated filesystem tools rather than shell redirection for edits. This makes exact target snapshotting useful, but not infallible: an approved shell command can still mutate arbitrary files.

## SDK versus daemon

Qwen documents `qwen serve` as an experimental HTTP/SSE ACP daemon. It is attractive for shared processes and replayable sessions, and the SDK now exports daemon clients. However, current official daemon design notes still document gaps around permission voting/reconnection and describe the VS Code daemon adapter as a migration spike rather than the default path.

Decision: the MVP uses the direct TypeScript SDK query transport. It is isolated behind `AgentClient`, so a daemon-backed implementation can be added without changing controllers or the webview. See ADR 0001.

## File-edit interception

The SDK does not expose a supported virtual-working-tree edit interception contract. Its permission callback runs immediately before sensitive tools and can inspect tool inputs. Therefore the supported MVP strategy is:

1. snapshot the exact target of a dedicated edit/write tool before approving it;
2. let Qwen Code modify the working tree;
3. capture the resulting content after the tool result;
4. treat the before/after pair as a pending review;
5. reject only when the live file still equals the captured agent result.

This cannot safely reconstruct arbitrary files changed by shell commands. Such changes are outside automatic rejection in the MVP rather than being presented with a false safety guarantee.

## VS Code APIs

- [`WebviewViewProvider`](https://code.visualstudio.com/api/references/vscode-api#WebviewViewProvider) and `window.registerWebviewViewProvider` are stable public APIs for an Activity Bar chat view.
- The [webview guide](https://code.visualstudio.com/api/extension-guides/webview) supports local resource roots, message passing, CSP sources/nonces, and theme variables. The webview must not receive SDK objects or secrets.
- [`TextDocumentContentProvider`](https://code.visualstudio.com/api/extension-guides/virtual-documents) is the stable API for readonly virtual documents. It is suitable for immutable original/proposed review content.
- `commands.executeCommand("vscode.diff", left, right, title)` is the documented command pattern used by official samples for the native diff editor.
- `workspace.fs` supports local and remote workspace URI reads/writes. `WorkspaceEdit` is all-or-nothing for text-only edits, but whole-file restore also needs explicit create/delete handling, so the implementation uses a narrow filesystem port backed by `workspace.fs` and `WorkspaceEdit` for open text replacements.
- The [Workspace Trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust) supports `capabilities.untrustedWorkspaces.supported: "limited"`, restricted configuration, `workspace.isTrusted`, and `onDidGrantWorkspaceTrust`. Commands must still enforce trust at runtime.
- Official [extension testing guidance](https://code.visualstudio.com/api/working-with-extensions/testing-extension) recommends `@vscode/test-cli`/`@vscode/test-electron` for Extension Host tests. Core logic is kept VS Code-free for fast Vitest coverage; Extension Host tests are a later milestone because the core safety behavior can be tested without a GUI or model.

## Compatibility conclusions

- No private Copilot API is necessary.
- No direct prompt or tool path to LM Studio belongs in this extension; the explicit model-list connectivity probe is the only provider call.
- Only settings with implemented behavior are contributed.
- Normal tests require neither Qwen Code execution nor a model provider.
