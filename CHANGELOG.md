# Changelog

## 0.2.0

- Add Qwen-runtime-backed slash-command discovery and autocomplete with custom command metadata, filtering, and keyboard/mouse selection.
- Add workspace file and directory references through `@` autocomplete, removable chips, bounded fuzzy search, multi-reference support, and native Qwen path serialization.
- Preserve reference metadata separately from visible prompt text and avoid model/file-content requests during autocomplete.
- Add composer, command discovery, workspace reference, serializer, and controller regression coverage with updated architecture and runtime research documentation.
- Preserve Qwen session continuity after cancelling a turn by using the SDK interrupt lifecycle and fresh per-turn cancellation state.
- Keep cancelled turns resumable and clear pending permissions and in-flight activity state so the next prompt can continue normally.
- Replace the model selector text caret with a responsive, theme-compatible chevron.
- Redesign “Jump to latest” as an accessible circular control anchored above the composer while preserving sticky-bottom behavior.
- Add cancellation lifecycle documentation and unit/live regression coverage.

## 0.1.0

- Initial SDK-based Qwen chat, tool activity, permission, session, and review architecture.
- Conflict-safe native diff review and per-file/bulk accept/reject workflow.
- Secret-safe Qwen model selection and OpenAI-compatible provider management, including remote LM Studio discovery and fresh-session switching.
