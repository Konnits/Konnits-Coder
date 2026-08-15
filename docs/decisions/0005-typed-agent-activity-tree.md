# ADR 0005: Typed Qwen activity tree and authoritative usage

## Context

Qwen SDK 0.1.8 exposes typed thinking blocks, partial thinking deltas, per-assistant usage, context control requests, Agent tool calls, and `parent_tool_use_id` on child messages. Flattening or converting these values to generic strings loses the distinction between reasoning, final text, tools, and subagent work. Reconstructing missing thoughts, usage, or agent ownership would be misleading.

## Decision

Normalize thinking start/chunk/completion, progressive turn usage, and parent relationships as discriminated domain events. Represent Qwen's `agent`/`task` tool as a subagent activity while leaving execution, discovery, permissions, and cancellation inside Qwen Code. Build a presentation tree from parent IDs and render child thoughts/tools inside the owning Agent item.

Use completed assistant UUIDs to deduplicate streamed content and usage. Use the main/subagent parent scope—not the partial envelope UUID—to correlate partial events. Measure thought duration locally because Qwen provides no duration. Refresh current context at debounced typed boundaries without overlapping control requests. Never assign usage to a thought, tool, or subagent unless a future public Qwen contract provides that attribution.

## Alternatives

- Parse prose markers such as "Thinking" or infer reasoning from assistant text. Rejected because it fabricates semantics and can expose ordinary text as hidden reasoning.
- Run child SDK queries in the extension. Rejected because it duplicates Qwen Code's Agent runtime and breaks its discovery, context, permission, and cancellation behavior.
- Flatten child activities. Rejected because concurrent subagents become ambiguous and permission/progress origin is lost.
- Estimate live context or per-step tokens. Rejected because provider context includes hidden instructions, tool traffic, caching, and compaction.

## Consequences

The domain and webview gain explicit thought, subagent hierarchy, and progressive usage concepts. The UI can safely collapse completed thoughts and subagents while keeping final responses separate. Partial correlation depends on the installed SDK's parent stream semantics and must be reviewed on SDK upgrades. SDK 0.1.8 cannot expose the parent ID in `CanUseTool`, so approval origin labels remain unavailable even though approvals stay actionable.
