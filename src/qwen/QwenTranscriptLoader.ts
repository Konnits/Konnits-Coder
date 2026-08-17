import { readFile } from "node:fs/promises";
import { describeTool } from "./QwenEventAdapter.js";
import type { TurnTokenUsage } from "../agent/TokenUsage.js";
import type { TimelineItem, ToolTimelineItem } from "../webview/messages.js";

/**
 * Reads persisted Qwen JSONL as display data only. This module deliberately
 * never sends a record back to Qwen or executes a historical tool call.
 */
export class QwenTranscriptLoader {
  async load(
    transcriptPath: string,
    sessionId: string,
  ): Promise<readonly TimelineItem[]> {
    const source = await readFile(transcriptPath, "utf8");
    return normalizeQwenTranscript(source, sessionId);
  }
}

export function normalizeQwenTranscript(
  source: string,
  sessionId: string,
): readonly TimelineItem[] {
  const timeline: TimelineItem[] = [];
  const tools = new Map<string, number>();
  let currentTurnStart = -1;
  let currentUsage: TurnTokenUsage | undefined;

  const finishTurn = (): void => {
    if (currentTurnStart === -1) {
      return;
    }
    const assistantIndex = findLastRootAssistantIndex(
      timeline,
      currentTurnStart,
    );
    const assistant =
      assistantIndex === -1 ? undefined : timeline[assistantIndex];
    if (assistant?.type === "assistant" && assistant.text.trim().length > 0) {
      timeline[assistantIndex] = {
        type: "finalResponse",
        id: assistant.id,
        text: assistant.text,
        ...(currentUsage === undefined ? {} : { turnUsage: currentUsage }),
      };
    } else if (currentUsage !== undefined) {
      timeline.push({
        type: "turnUsage",
        id: `${sessionId}:usage:${String(currentTurnStart)}`,
        usage: currentUsage,
      });
    }
    currentUsage = undefined;
  };

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        continue;
      }
      value = parsed;
    } catch {
      // A live transcript can have an incomplete final JSONL record.
      continue;
    }

    const type = typeof value.type === "string" ? value.type : "";
    if (type === "user") {
      const text = readMessageText(value);
      if (text !== undefined) {
        finishTurn();
        currentTurnStart = timeline.length;
        timeline.push({
          type: "user",
          id: recordId(value, sessionId, index),
          text,
        });
      }
      applyToolResults(value, timeline, tools);
      continue;
    }
    if (type === "assistant") {
      if (currentTurnStart === -1) {
        currentTurnStart = timeline.length;
      }
      const record = recordId(value, sessionId, index);
      const timestamp = readTimestamp(value) ?? Date.now();
      const parentId = readString(value.parent_tool_use_id);
      const parts = readMessageParts(value);
      for (const [partIndex, part] of parts.entries()) {
        const thought = part.thought === true;
        const text = readString(part.text);
        if (text !== undefined && text.length > 0) {
          if (thought) {
            timeline.push({
              type: "thinking",
              id: `${record}:thinking:${String(partIndex)}`,
              text,
              complete: true,
              startedAt: timestamp,
              durationMs: 0,
              ...(parentId === undefined ? {} : { parentId }),
            });
          } else {
            timeline.push({
              type: "assistant",
              id: `${record}:text:${String(partIndex)}`,
              text,
              complete: true,
              ...(parentId === undefined ? {} : { parentId }),
            });
          }
        }
        const call = readFunctionCall(part.functionCall);
        if (call !== undefined) {
          const presentation = describeTool(call.name, asToolInput(call.args));
          const item: ToolTimelineItem = {
            type: "tool",
            id: call.id ?? `${record}:tool:${String(partIndex)}`,
            kind: presentation.kind,
            title: presentation.title,
            ...(presentation.detail === undefined
              ? {}
              : { detail: presentation.detail }),
            ...(presentation.subagentName === undefined
              ? {}
              : { subagentName: presentation.subagentName }),
            ...(presentation.background === undefined
              ? {}
              : { background: presentation.background }),
            state: "cancelled",
          };
          tools.set(item.id, timeline.length);
          timeline.push(item);
        }
      }
      currentUsage = readHistoricalUsage(value) ?? currentUsage;
      continue;
    }
    if (type === "tool_result") {
      applyToolResults(value, timeline, tools);
    }
  }
  finishTurn();
  return timeline;
}

function applyToolResults(
  value: Record<string, unknown>,
  timeline: TimelineItem[],
  tools: Map<string, number>,
): void {
  const result = isRecord(value.toolCallResult)
    ? value.toolCallResult
    : undefined;
  const messageParts = readMessageParts(value);
  const callId =
    (result === undefined ? undefined : readString(result.callId)) ??
    messageParts
      .map((part) =>
        isRecord(part.functionResponse)
          ? readString(part.functionResponse.id)
          : undefined,
      )
      .find((candidate): candidate is string => candidate !== undefined);
  if (callId === undefined) {
    return;
  }
  const timelineIndex = tools.get(callId);
  if (timelineIndex === undefined) {
    return;
  }
  const item = timeline[timelineIndex];
  if (item?.type !== "tool") {
    return;
  }
  const status = result === undefined ? undefined : readString(result.status);
  const output =
    result === undefined
      ? undefined
      : (readString(result.resultDisplay) ?? stringify(result.result));
  timeline[timelineIndex] = {
    ...item,
    state:
      status === undefined || status === "success" ? "succeeded" : "failed",
    ...(output === undefined ? {} : { output }),
  };
  tools.delete(callId);
}

function findLastRootAssistantIndex(
  timeline: readonly TimelineItem[],
  start: number,
): number {
  for (let index = timeline.length - 1; index > start; index -= 1) {
    const item = timeline[index];
    if (item?.type === "assistant" && item.parentId === undefined) {
      return index;
    }
  }
  return -1;
}

function readMessageParts(
  value: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const message = isRecord(value.message) ? value.message : undefined;
  const parts = message === undefined ? undefined : message.parts;
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
}

function readMessageText(value: Record<string, unknown>): string | undefined {
  const message = isRecord(value.message) ? value.message : undefined;
  const parts = readMessageParts(value);
  const text = parts
    .map((part) => readString(part.text))
    .filter((part): part is string => part !== undefined)
    .join("");
  if (text.length > 0) {
    return text;
  }
  return message === undefined ? undefined : readString(message.content);
}

function readFunctionCall(
  value: unknown,
):
  | { readonly id?: string; readonly name: string; readonly args: unknown }
  | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    name: value.name,
    args: value.args,
  };
}

function readHistoricalUsage(
  value: Record<string, unknown>,
): TurnTokenUsage | undefined {
  const usage = isRecord(value.usageMetadata) ? value.usageMetadata : undefined;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = readNonNegativeInteger(usage.promptTokenCount);
  const candidateTokens = readNonNegativeInteger(usage.candidatesTokenCount);
  const thoughtTokens = readNonNegativeInteger(usage.thoughtsTokenCount) ?? 0;
  const totalTokens = readNonNegativeInteger(usage.totalTokenCount);
  if (
    inputTokens === undefined ||
    candidateTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens: candidateTokens + thoughtTokens,
    cacheReadInputTokens:
      readNonNegativeInteger(usage.cachedContentTokenCount) ?? 0,
    cacheCreationInputTokens: 0,
    totalTokens,
    accuracy: "exact",
  };
}

function recordId(
  value: Record<string, unknown>,
  sessionId: string,
  index: number,
): string {
  return readString(value.uuid) ?? `${sessionId}:record:${String(index)}`;
}

function readTimestamp(value: Record<string, unknown>): number | undefined {
  const raw = value.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function asToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
