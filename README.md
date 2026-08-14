# Qwen Frontend

Qwen Frontend is a review-first Visual Studio Code interface for [Qwen Code](https://github.com/QwenLM/qwen-code). Qwen Code remains the coding agent; this extension supplies chat, structured activity, permissions, native diff review, and conflict-safe accept/reject controls.

## Development

Requirements: Node.js 22 or newer (available as `node` to the extension host) and VS Code 1.125 or newer.

```sh
npm install
npm run check
```

Run the `Extension` launch configuration or press F5 in VS Code. Configure and authenticate Qwen Code using its own settings. Normal chat and tool traffic never bypasses Qwen Code; only an explicit **Test connection** action requests the provider's OpenAI-compatible model list.

## Qwen and local-provider setup

By default, the extension uses the Qwen CLI bundled with `@qwen-code/sdk`. This keeps the SDK transport and CLI protocol aligned. To use another officially compatible Qwen CLI, set `qwenFrontend.qwen.executablePath` to a command available to the VS Code extension host (for example `qwen`) or to an absolute CLI JavaScript/binary path. The Qwen Frontend Output identifies the selected source, path, and version.

On Windows, VS Code extensions run under `Code.exe`. The SDK otherwise reuses that Electron executable to launch JavaScript CLIs, which is incompatible with the bundled Qwen 0.19.10 argument handling. Qwen Frontend routes JavaScript CLI launches through `dist/qwen-cli-launcher.mjs`; the bootstrap transparently runs the same CLI under the required external Node.js 22+ runtime while preserving SDK stdin/stdout and cancellation. Native configured executables are not wrapped.

Qwen owns provider configuration and authentication. The compact model control in the chat header reads and safely updates Qwen's user `settings.json`; it does not create a separate Konnits-Coder provider store. **Select Model**, **Add OpenAI-Compatible Model**, **Manage Models**, and **Open Qwen Settings** are also available from the Command Palette.

For an authenticated OpenAI-compatible server, the native VS Code add/edit flow stores a new token in Qwen's user `.qwen/.env` and writes only its generated `envKey` to the provider entry. The extension reports only whether a credential exists and never sends the token or `envKey` to the webview or logs. Existing credentials in the process environment, `.env`, or the legacy `settings.json` `env` field remain supported and are not migrated automatically.

Model switches are disabled while Qwen is running, connecting, waiting for permission, or cancelling. A successful switch updates Qwen's active `model.name`, `model.baseUrl`, and `security.auth.selectedType`, clears stale chat/context state, and starts a fresh session so the next SDK query reloads the selected provider. Normal prompts and tools always follow `Konnits-Coder → @qwen-code/sdk → Qwen Code → configured provider`; only the explicit connection test calls the provider's `GET /models` endpoint directly.

### Remote LM Studio

To keep Qwen Code and its tools on Computer A while running the model on Computer B:

1. On Computer B, load the model in LM Studio, start its OpenAI-compatible server, enable network/LAN listening, and permit the chosen TCP port through the host firewall. Prefer a trusted private network; use TLS or a trusted tunnel when traffic crosses an untrusted network.
2. On Computer A, click the model name in the chat header and choose **Add OpenAI-compatible model…**. Enter a distinct display name, the exact model ID, and Computer B's address, for example `http://192.168.1.20:1234/v1`.
3. Optionally set the context window, reasoning effort, and API token. Choose **Test connection and save** to validate `GET /v1/models` and discover the IDs exposed by Computer B.
4. Select the saved model. Konnits-Coder starts a new Qwen session; Qwen and all filesystem/shell tools continue running on Computer A while Qwen's provider requests go to Computer B.

Unencrypted remote HTTP receives an explicit warning because prompts, source context, and tokens can be observed on the network. A workspace `.qwen/settings.json` containing `modelProviders` overrides user providers; Konnits-Coder warns and offers to open that file rather than modifying project configuration automatically.

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
- Selects and manages Qwen user models, including duplicate model IDs at different OpenAI-compatible endpoints, with conflict-safe settings writes and secret-isolated credentials.

See `docs/roadmap.md` for current limitations and future daemon support.
