# Qwen Frontend

Qwen Frontend is a review-first Visual Studio Code interface for [Qwen Code](https://github.com/QwenLM/qwen-code). Qwen Code remains the coding agent; this extension supplies chat, structured activity, permissions, native diff review, and conflict-safe accept/reject controls.

## Development

Requirements: Node.js 22 or newer (available as `node` to the extension host) and VS Code 1.125 or newer.

```sh
npm install
npm run check
```

Run the `Extension` launch configuration or press F5 in VS Code. Configure and authenticate Qwen Code using its own settings. The extension never talks directly to LM Studio or another model provider.

## Qwen and local-provider setup

By default, the extension uses the Qwen CLI bundled with `@qwen-code/sdk`. This keeps the SDK transport and CLI protocol aligned. To use another officially compatible Qwen CLI, set `qwenFrontend.qwen.executablePath` to a command available to the VS Code extension host (for example `qwen`) or to an absolute CLI JavaScript/binary path. The Qwen Frontend Output identifies the selected source, path, and version.

On Windows, VS Code extensions run under `Code.exe`. The SDK otherwise reuses that Electron executable to launch JavaScript CLIs, which is incompatible with the bundled Qwen 0.19.10 argument handling. Qwen Frontend routes JavaScript CLI launches through `dist/qwen-cli-launcher.mjs`; the bootstrap transparently runs the same CLI under the required external Node.js 22+ runtime while preserving SDK stdin/stdout and cancellation. Native configured executables are not wrapped.

Qwen owns provider configuration and authentication. For an authenticated OpenAI-compatible local server, define the token through the provider entry's `envKey` using `~/.qwen/.env`, the process environment, or Qwen's `settings.json` `env` field. The extension reports only whether the credential exists and never sends it to the webview. Qwen recommends `.env` over `settings.json` because `settings.json` stores `env` values as plaintext.

Provider-specific request controls belong directly under the provider model's `generationConfig`. Only provider request-body extensions belong in `extra_body`:

```json
{
  "generationConfig": {
    "maxRetries": 3,
    "contextWindowSize": 262144,
    "extra_body": {
      "enable_thinking": true
    }
  }
}
```

Run `npm run diagnose:qwen` for a deterministic, secret-redacted SDK-to-provider smoke test outside the webview. `npm run diagnose:qwen:missing-session` intentionally reproduces the stale-session exit used by the session-recovery tests and is expected to fail with exit code 1.

Set `QWEN_LIVE_TEST=1` and run `npm run test:live:qwen` to exercise the real `QwenCodeAgentClient` through the SDK and configured provider. This opt-in test is excluded from the normal offline test suite.

## MVP behavior

- Streams assistant output from `@qwen-code/sdk`.
- Renders Qwen tools as typed activity rather than raw protocol JSON.
- Requests approval for write and command tools.
- Captures before/after content for dedicated Qwen edit tools.
- Opens deterministic native VS Code diffs.
- Accepts or rejects per-file and in bulk, with hash and dirty-document conflict checks.
- Cancels active SDK queries and persists the Qwen session ID per workspace.
- Recovers once as a new session when a persisted ID was never created by Qwen.

See `docs/roadmap.md` for current limitations and future daemon support.
