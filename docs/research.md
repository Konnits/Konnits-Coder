# API research

Research date: 2026-08-14. Only stable public VS Code APIs and official Qwen Code documentation/source were used.

## Qwen Code

The supported programmatic surface is [`@qwen-code/sdk`](https://qwenlm.github.io/qwen-code-docs/en/developers/sdk-typescript/). Version 0.1.8 was inspected from npm, including its shipped TypeScript declarations.

Confirmed SDK behavior:

- `query({ prompt, options })` returns an async iterable `Query`.
- `includePartialMessages: true` emits `stream_event` messages with text/thinking deltas.
- completed assistant messages contain typed `text`, `thinking`, `tool_use`, and `tool_result` content blocks.
- `Query.interrupt()` and an `AbortController` provide cancellation.
- `sessionId` creates a caller-chosen session and `resume` resumes it on a later query.
- `permissionMode: "default"` permits read-only tools and calls `canUseTool` for writes/commands; absent approval is fail-closed.
- `pathToQwenExecutable` is optional in the 0.1.8 declarations because the package includes a bundled CLI. It can still target an explicit installed Qwen executable.
- The SDK and current Qwen Code require Node.js 22 or newer.

### Token and context usage

The installed 0.1.8 declarations and implementation expose three relevant public values:

- every completed assistant API message has `message.usage` for that model call;
- every SDK result has aggregate `usage` for the complete agent turn;
- `Query.getContextUsage(showDetails?)` sends the typed `get_context_usage` control request and returns the current session context data.

The bundled CLI 0.19.10 response was inspected. It includes `totalTokens`, `contextWindowSize`, `modelName`, and `isEstimated`. `totalTokens` is the content generator's last prompt token count, while `contextWindowSize` comes from Qwen's effective generation configuration (falling back inside Qwen itself). The extension therefore does not hardcode a capacity or contact LM Studio directly.

A live SDK probe against the configured local Qwen model confirmed the distinction. One simple turn reported 39,023 cumulative input tokens and 196 output tokens at result level, while current context was 23,173 of 262,144 tokens. The current-context value matched the last model prompt rather than the result's cumulative input. Context is consequently stored independently and lower later values are accepted as valid compaction.

With a single-string SDK prompt, the transport closes input as soon as the result is routed, leaving no reliable control-request window. The extension now uses the SDK's documented `AsyncIterable<SDKUserMessage>` prompt form for the same one user message, keeps that input stream open through the result, requests current context, and then closes it. This changes transport lifetime only; sessions remain one SDK query per user turn. Context-control failures are caught and do not change a successful agent result into a failed turn.

No public SDK API tokenizes an arbitrary visible message independently of hidden instructions, tool traffic, or the complete model turn. Visible user and final-response counts therefore use a model-independent UTF-8 byte heuristic and are explicitly marked `~`; they must not be described as Qwen tokenizer results.

### Windows LM Studio failure investigation

The failing execution path was reproduced independently of VS Code on Windows 11. The installed package versions were:

- `@qwen-code/sdk`: 0.1.8
- SDK-bundled Qwen CLI: 0.19.10
- previously reported global CLI: 0.21.12; it was not discoverable from the current extension/tool environment (`Get-Command qwen`, `where qwen`, and the npm global package directory found no installation), so it is not the executable Konnits-Coder uses

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
- No direct LM Studio API belongs in this extension.
- Only settings with implemented behavior are contributed.
- Normal tests require neither Qwen Code execution nor a model provider.
