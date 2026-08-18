# Changelog

## 0.4.0

- Redesign the chat scroll region with a correctly anchored jump-to-latest control and processing panels that use the available vertical space.
- Show nested subagent thinking and activity as structured expandable trees, while rendering direct Qwen messages outside Processing and reopening Processing when later work begins.
- Present current Todos and changed files as bottom-docked compact disclosure panels with status, diff counts, native review actions, and safe accept/reject controls.
- Add a bounded auto-growing composer and make slash-command suggestions keyboard accessible, scroll the focused option into view, and complete selections with Enter or Tab.
- Allow users to send follow-up messages while Qwen is working through the active SDK query input stream.
- Add a composer permission control with approval-based `default`, read-only `plan`, and risk-acknowledged `yolo` full-access modes backed by centralized, fail-closed configuration.
- Support native file attachments and pasted images through validated, size-limited, extension-owned temporary storage and Qwen workspace references.
- Add prompt retry plus conflict-safe prompt editing and per-prompt file restoration using in-memory checkpoints and Qwen conversation-only rewind.
- Add regression coverage for activity presentation, attachments, scrolling, disclosures, composer behavior, checkpoints, prompt rewind, typed contracts, and Qwen event adaptation.
- Prevent streamed Qwen commentary from being duplicated across internal block transitions, keep completed reads out of edit tracking, and allow Qwen-managed auto-memory updates without treating them as workspace changes.

## 0.3.0

- Route slash commands through a unified registry before Qwen execution; add native `/help` and daemon-backed `/agents` listing plus local unknown/unavailable results.
- Use the same dynamic registry for autocomplete, routing, availability, and help, without a duplicated hardcoded Qwen command catalog.
- Fix `/agents` daemon startup in the Windows Extension Host by launching the JavaScript bootstrap through Electron's supported Node mode instead of spawning `.mjs` directly.
- Add rich slash-command suggestions with Qwen/runtime descriptions, usage hints, aliases, custom-command metadata, source labels, responsive rows, and zero-inference discovery.
- Add a native VS Code Chat History picker backed by Qwen's real workspace-scoped session catalog, with search, useful titles and timestamps, and current-session identification.
- Restore saved Qwen transcripts into the chat UI, including user and assistant messages, thinking, tool activity, and authoritative usage metadata without replaying historical tools.
- Resume the actual Qwen session through the SDK, refresh model/context state, restore follow-latest behavior, and preserve canonical multi-root workspace selection.
- Add confirmed per-session deletion and inactive-history cleanup with active-session protection, workspace isolation, transcript ownership checks, and Qwen sidecar cleanup.
- Recover once from the transient Qwen extension-store shutdown lock while preserving resume semantics.
- Add comprehensive command, history, transcript, controller, deletion-safety, scrolling, and disposable real-Qwen integration coverage.
- Gate image input behind `qwenFrontend.qwen.allowImageInput` (off by default) so text-only models are protected from image reads, with actionable guidance when a model rejects an image.
- Fail stalled turns when the Qwen SDK stream goes silent instead of hanging, configurable via `qwenFrontend.qwen.streamIdleTimeoutMs` and disableable with 0.

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
