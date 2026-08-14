# ADR 0004: Qwen-owned model management

## Context

Konnits-Coder needs an accessible current-model selector and a workflow for adding remote OpenAI-compatible providers such as LM Studio on another computer. Qwen Code remains the coding agent and already owns provider resolution, credentials, model selection, reasoning configuration, and precedence between user and workspace settings. A parallel extension configuration would drift from `/model`, while changing an active SDK query could retain context produced by a different model or provider.

Qwen settings contain unrelated user configuration and may be edited concurrently. Credentials must not enter the React webview or logs. Workspace `modelProviders` can replace the user catalog, so writing only user settings may appear to succeed while having no effect.

## Decision

Konnits-Coder edits Qwen's user `settings.json` through a dedicated `QwenSettingsService` that targets the installed CLI schema. Models are identified by auth type, ID, and normalized base URL. Selection persists the same auth/model/base tuple used by Qwen's `/model` command.

The service refuses invalid JSON, unsupported provider shapes, workspace overrides, and concurrent changes. It preserves unknown fields, creates a one-time backup, and replaces files through a same-directory temporary file. New API tokens are stored in Qwen's `.env`; only a generated `envKey` is written to settings. The webview receives only display metadata and credential presence.

The native management controller may directly call `GET /models` to test an explicitly supplied OpenAI-compatible endpoint. It never sends prompts or tool traffic. Switching is disabled while Qwen is busy and always creates a fresh session after the Qwen selection is saved.

## Alternatives

- Store providers in VS Code settings and pass overrides to the SDK. Rejected because it creates a second source of truth and does not match Qwen's own `/model` behavior.
- Deep-import Qwen CLI settings helpers. Rejected because generated CLI chunks are private, unstable APIs.
- Call `Query.setModel` on the current SDK query. Rejected because provider reload and old-context behavior are inappropriate for a deterministic cross-provider switch.
- Modify workspace `.qwen/settings.json` automatically. Rejected because project settings may be shared and user intent is ambiguous.

## Consequences

Qwen CLI remains the only runtime provider owner, duplicate IDs at different endpoints work, credentials stay out of webview state, and model switches have deterministic session boundaries. Settings updates are conservative but serialize JSON formatting. The adapter must be reviewed when the pinned SDK changes its provider schema. Removal is deferred until credential-reference cleanup can be made safely.
