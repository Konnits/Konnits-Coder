import { describe, expect, it, vi } from "vitest";
import type { Query, QueryOptions, SDKMessage } from "@qwen-code/sdk";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import { PermissionManager } from "../../src/permissions/PermissionManager.js";
import {
  QwenCodeAgentClient,
  describeSdkMessageForDebug,
  resolveCliLaunch,
  type QwenChangeTracker,
  type QwenQueryFactory,
  type QwenSubagentResolver,
} from "../../src/qwen/QwenCodeAgentClient.js";
import type { QwenSubagentResolution } from "../../src/qwen/QwenSubagentRegistry.js";

describe("QwenCodeAgentClient", () => {
  it("keeps the exact user prompt separate from executable configuration", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const queryFactory = vi.fn(((request) => {
      requests.push(request);
      return successfulQuery();
    }) as QwenQueryFactory);
    const client = createClient(queryFactory, {
      executablePath: "C:\\qwen\\dist\\cli\\cli.js",
    });

    await client.run({
      prompt: "Analiza el repositorio.",
      workspacePath: "C:\\actual-workspace",
      sessionId: "00000000-0000-4000-8000-000000000000",
      resume: false,
    });

    expect(requests).toHaveLength(1);
    const prompt = requests[0]?.prompt;
    expect(typeof prompt).not.toBe("string");
    if (typeof prompt === "string" || prompt === undefined) {
      throw new Error("Expected a controlled SDK user-message stream.");
    }
    const iterator = prompt[Symbol.asyncIterator]();
    const firstMessage = await iterator.next();
    if (firstMessage.done) {
      throw new Error("Expected the user prompt message.");
    }
    expect(firstMessage.value.message.content).toBe("Analiza el repositorio.");
    await iterator.return?.();
    expect(requests[0]?.options?.cwd).toBe("C:\\actual-workspace");
    expect(requests[0]?.options?.pathToQwenExecutable).toBe(
      "C:\\qwen\\dist\\cli\\cli.js",
    );
    expect(firstMessage.value.message.content).not.toBe(
      requests[0]?.options?.pathToQwenExecutable,
    );
  });

  it("enables partial messages without restricting Qwen's agent tool", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const client = createClient(
      vi.fn(((request) => {
        requests.push(request);
        return successfulQuery();
      }) as QwenQueryFactory),
    );

    await client.run(runRequest());

    expect(requests[0]?.options?.includePartialMessages).toBe(true);
    expect(requests[0]?.options?.coreTools).toBeUndefined();
    expect(requests[0]?.options?.excludeTools).toBeUndefined();
  });

  it("reattaches a saved session without emitting a user prompt", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const close = vi.fn(async () => undefined);
    const query = {
      close,
      getContextUsage: vi.fn(async () => ({
        totalTokens: 12,
        contextWindowSize: 100,
        isEstimated: false,
      })),
      isClosed: () => false,
    } as unknown as Query;
    const queryFactory = vi.fn(((request) => {
      requests.push(request);
      return query;
    }) as QwenQueryFactory);
    const client = createClient(queryFactory);

    const result = await client.restoreSession({
      sessionId: "66666666-6666-4666-8666-666666666666",
      workspacePath: "C:\\workspace",
    });

    expect(result.contextUsage).toMatchObject({
      usedTokens: 12,
      contextWindowTokens: 100,
    });
    expect(requests).toHaveLength(1);
    expect(typeof requests[0]?.prompt).not.toBe("string");
    expect(requests[0]?.options?.resume).toBe(
      "66666666-6666-4666-8666-666666666666",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("passes Qwen-discovered subagents as session configuration without replacing discovery", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const queryFactory = vi.fn(((request) => {
      requests.push(request);
      return successfulQuery();
    }) as QwenQueryFactory);
    const resolution = subagentResolution([
      {
        name: "general-purpose",
        description: "Qwen built-in general-purpose agent",
        systemPrompt: "Use Qwen tools to complete the task.",
        level: "session",
        isBuiltin: true,
      },
    ]);
    const resolver: QwenSubagentResolver = vi.fn(async () => resolution);
    const client = createClient(queryFactory, {}, resolver);

    await client.connect();
    await client.run(runRequest());

    expect(resolver).toHaveBeenCalledOnce();
    expect(requests[0]?.options?.agents).toEqual(resolution.agents);
  });

  it("does not turn unavailable Qwen discovery into an empty agents array", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const queryFactory = vi.fn(((request) => {
      requests.push(request);
      return successfulQuery();
    }) as QwenQueryFactory);
    const resolver: QwenSubagentResolver = vi.fn(async () =>
      subagentResolution(undefined),
    );
    const client = createClient(queryFactory, {}, resolver);

    await client.connect();
    await client.run(runRequest());

    expect(requests[0]?.options?.agents).toBeUndefined();
  });

  it("uses the Electron bootstrap only for JavaScript CLIs on Windows", () => {
    expect(
      resolveCliLaunch(
        undefined,
        "C:\\qwen\\dist\\cli\\cli.js",
        "win32",
        "42.8.0",
        "C:\\extension\\dist\\qwen-cli-launcher.mjs",
      ),
    ).toEqual({
      executablePath: "C:\\extension\\dist\\qwen-cli-launcher.mjs",
      targetPath: "C:\\qwen\\dist\\cli\\cli.js",
    });
    expect(
      resolveCliLaunch("qwen", "qwen", "win32", "42.8.0", "launcher"),
    ).toEqual({ executablePath: "qwen" });
    expect(
      resolveCliLaunch(undefined, "C:\\qwen\\cli.js", "win32", undefined),
    ).toEqual({});
  });

  it("continues consuming events after a tool result until final completion", async () => {
    const queryFactory = vi.fn((() => toolLoopQuery()) as QwenQueryFactory);
    const client = createClient(queryFactory);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    await client.run({
      prompt: "Read README.md and summarize it.",
      workspacePath: "C:\\workspace",
      sessionId: "00000000-0000-4000-8000-000000000000",
      resume: false,
    });

    expect(events).toEqual(
      expect.arrayContaining([
        "tool.started",
        "tool.completed",
        "assistant.message.chunk",
        "assistant.message.completed",
        "agent.completed",
      ]),
    );
    expect(events.indexOf("agent.completed")).toBeGreaterThan(
      events.indexOf("tool.completed"),
    );
  });

  it("emits authoritative turn and current-context usage separately", async () => {
    const queryFactory = vi.fn((() => usageQuery()) as QwenQueryFactory);
    const client = createClient(queryFactory);
    const events: AgentEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.run({
      prompt: "hello",
      workspacePath: "C:\\workspace",
      sessionId: "session-usage",
      resume: false,
    });

    const context = events.find(
      (event) => event.type === "context.usage.updated",
    );
    expect(context?.type === "context.usage.updated" && context.sessionId).toBe(
      "session-usage",
    );
    expect(
      context?.type === "context.usage.updated" && context.usage,
    ).toMatchObject({ usedTokens: 23_173, contextWindowTokens: 262_144 });
    const completed = events.find((event) => event.type === "agent.completed");
    expect(
      completed?.type === "agent.completed" && completed.turnUsage,
    ).toMatchObject({ inputTokens: 39_023, outputTokens: 196 });
  });

  it("emits cumulative per-call usage progressively without double-counting message IDs", async () => {
    const client = createClient(
      vi.fn((() => progressiveUsageQuery()) as QwenQueryFactory),
    );
    const usages: AgentEvent[] = [];
    client.onEvent((event) => {
      if (event.type === "turn.usage.updated") {
        usages.push(event);
      }
    });

    await client.run(runRequest());

    expect(
      usages.map((event) =>
        event.type === "turn.usage.updated"
          ? [event.usage.inputTokens, event.usage.outputTokens]
          : [],
      ),
    ).toEqual([
      [10, 2],
      [30, 5],
    ]);
  });

  it("refreshes context after a tool boundary before the final result", async () => {
    let resultReached = false;
    const observations: boolean[] = [];
    const query = fakeQuery(
      async function* () {
        yield assistantToolMessage();
        await new Promise((resolve) => setTimeout(resolve, 650));
        resultReached = true;
        yield resultMessage("done");
      },
      async () => {
        observations.push(resultReached);
        return null;
      },
    );
    const client = createClient(vi.fn((() => query) as QwenQueryFactory));

    await client.run(runRequest());

    expect(observations).toContain(false);
  });

  it("does not fail a turn when context retrieval fails", async () => {
    const queryFactory = vi.fn((() =>
      successfulQuery(async () => {
        throw new Error("context unavailable");
      })) as QwenQueryFactory);
    const client = createClient(queryFactory);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    await client.run({
      prompt: "hello",
      workspacePath: "C:\\workspace",
      sessionId: "session",
      resume: false,
    });

    expect(events).toContain("agent.completed");
    expect(events).not.toContain("agent.failed");
  });

  it("interrupts and reports cancellation for an active query", async () => {
    let query: Query | undefined;
    const interrupt = vi.fn(async () => undefined);
    const queryFactory = vi.fn(((request) => {
      query = cancellableQuery(request.options, interrupt);
      return query;
    }) as QwenQueryFactory);
    const client = createClient(queryFactory);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    const run = client.run({
      prompt: "wait",
      workspacePath: "C:\\workspace",
      sessionId: "00000000-0000-4000-8000-000000000000",
      resume: false,
    });
    await vi.waitFor(() => expect(query).toBeDefined());
    await client.cancel();
    await run;

    expect(interrupt).toHaveBeenCalledOnce();
    expect(events).toContain("agent.cancelled");
    expect(events).not.toContain("agent.completed");
  });

  it("uses a fresh per-turn abort controller after cancellation", async () => {
    const optionsSeen: QueryOptions[] = [];
    let first = true;
    const interrupt = vi.fn(async () => undefined);
    const queryFactory = vi.fn(((request) => {
      optionsSeen.push(request.options ?? {});
      if (first) {
        first = false;
        return cancellableQuery(request.options, interrupt);
      }
      return successfulQuery();
    }) as QwenQueryFactory);
    const client = createClient(queryFactory);

    const cancelledRun = client.run({ ...runRequest(), prompt: "first" });
    await vi.waitFor(() => expect(optionsSeen).toHaveLength(1));
    await client.cancel();
    await cancelledRun;
    await client.run({ ...runRequest(), prompt: "second", resume: true });

    expect(optionsSeen[0]?.abortController?.signal.aborted).toBe(false);
    expect(optionsSeen[1]?.abortController).not.toBe(
      optionsSeen[0]?.abortController,
    );
  });

  it("keeps the parent turn running after a foreground subagent result", async () => {
    const client = createClient(
      vi.fn((() => subagentLoopQuery()) as QwenQueryFactory),
    );
    const events: AgentEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.run(runRequest());

    const agentCompletedIndex = events.findIndex(
      (event) => event.type === "tool.completed" && event.callId === "agent-1",
    );
    const parentTextIndex = events.findIndex(
      (event) =>
        event.type === "assistant.message.chunk" &&
        event.text === "Parent summary",
    );
    expect(agentCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(parentTextIndex).toBeGreaterThan(agentCompletedIndex);
    expect(events.at(-1)?.type).toBe("agent.completed");
  });

  it("logs only event structure in debug diagnostics", () => {
    const message = {
      type: "stream_event",
      uuid: "secret-prompt",
      session_id: "session",
      parent_tool_use_id: "agent-1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "sensitive reasoning" },
      },
    } as SDKMessage;
    const diagnostic = describeSdkMessageForDebug(message);
    expect(diagnostic).toContain("delta=thinking_delta");
    expect(diagnostic).toContain("parent=yes");
    expect(diagnostic).not.toContain("sensitive reasoning");
    expect(diagnostic).not.toContain("secret-prompt");
  });

  it("retries a missing persisted session once as a new session", async () => {
    const optionsSeen: QueryOptions[] = [];
    const queryFactory = vi.fn(((request) => {
      optionsSeen.push(request.options ?? {});
      return optionsSeen.length === 1
        ? failingMissingSessionQuery(request.options)
        : successfulQuery();
    }) as QwenQueryFactory);
    const logger = {
      debug: vi.fn<(message: string) => void>(),
      info: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    };
    const changes: QwenChangeTracker = {
      beforeEdit: vi.fn(async () => undefined),
      afterEdit: vi.fn(async () => undefined),
      completeAll: vi.fn(async () => undefined),
    };
    const client = new QwenCodeAgentClient(
      () => ({ debug: false }),
      new PermissionManager(),
      changes,
      logger,
      queryFactory,
    );
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    await client.run({
      prompt: "hello",
      workspacePath: "C:\\workspace",
      sessionId: "00000000-0000-4000-8000-000000000000",
      resume: true,
    });

    expect(queryFactory).toHaveBeenCalledTimes(2);
    expect(optionsSeen[0]?.resume).toBe("00000000-0000-4000-8000-000000000000");
    expect(optionsSeen[1]?.sessionId).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
    expect(events).toContain("agent.completed");
    expect(events).not.toContain("agent.failed");
    expect(logger.info).toHaveBeenCalledWith(
      "The persisted Qwen session does not exist; retrying once as a new session.",
    );
  });

  it("retries a transient extension-store lock without changing resume semantics", async () => {
    const optionsSeen: QueryOptions[] = [];
    const queryFactory = vi.fn(((request) => {
      optionsSeen.push(request.options ?? {});
      return optionsSeen.length === 1
        ? failingExtensionStoreQuery()
        : successfulQuery();
    }) as QwenQueryFactory);
    const logger = {
      debug: vi.fn<(message: string) => void>(),
      info: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    };
    const client = new QwenCodeAgentClient(
      () => ({ debug: false }),
      new PermissionManager(),
      {
        beforeEdit: vi.fn(async () => undefined),
        afterEdit: vi.fn(async () => undefined),
        completeAll: vi.fn(async () => undefined),
      },
      logger,
      queryFactory,
      undefined,
      async () => undefined,
    );
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    await client.run({
      prompt: "continue",
      workspacePath: "C:\\workspace",
      sessionId: "00000000-0000-4000-8000-000000000000",
      resume: true,
    });

    expect(queryFactory).toHaveBeenCalledTimes(2);
    expect(optionsSeen.map((options) => options.resume)).toEqual([
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(events).toContain("agent.completed");
    expect(events).not.toContain("agent.failed");
    expect(logger.info).toHaveBeenCalledWith(
      "The Qwen extension store is still closing; retrying once.",
    );
  });
});

function createClient(
  queryFactory: QwenQueryFactory,
  configuration: { readonly executablePath?: string } = {},
  subagentResolver?: QwenSubagentResolver,
): QwenCodeAgentClient {
  return new QwenCodeAgentClient(
    () => ({ ...configuration, debug: false }),
    new PermissionManager(),
    {
      beforeEdit: vi.fn(async () => undefined),
      afterEdit: vi.fn(async () => undefined),
      completeAll: vi.fn(async () => undefined),
    },
    {
      debug: vi.fn<(message: string) => void>(),
      info: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    },
    queryFactory,
    subagentResolver,
  );
}

function subagentResolution(
  agents: QwenSubagentResolution["agents"],
): QwenSubagentResolution {
  return {
    ...(agents === undefined ? {} : { agents }),
    diagnostics: {
      workspacePath: "C:\\workspace",
      childWorkingDirectory: "C:\\workspace",
      childUserProfile: "C:\\Users\\test",
      childHome: "C:\\Users\\test",
      userAgentDirectory: "C:\\Users\\test\\.qwen\\agents",
      projectAgentDirectory: "C:\\workspace\\.qwen\\agents",
      userAgentsDiscovered: [],
      projectAgentsDiscovered: [],
      builtInAgents: agents === undefined ? "unavailable" : ["general-purpose"],
      agentToolAvailable: "unavailable",
      agentRuntimeAvailable: agents === undefined ? "unavailable" : "yes",
      modelVisibleAgentNames: "unavailable",
      runtimeAgentNames:
        agents === undefined ? "unavailable" : ["general-purpose"],
    },
  };
}

function failingMissingSessionQuery(options: QueryOptions | undefined): Query {
  return fakeQuery(async function* () {
    options?.stderr?.(
      "No saved session found with ID 00000000-0000-4000-8000-000000000000.",
    );
    yield await Promise.reject(new Error("CLI process exited with code 1"));
  });
}

function failingExtensionStoreQuery(): Query {
  return fakeQuery(async function* () {
    yield await Promise.reject(
      new Error(
        "Extension store is busy at C:\\Users\\test\\.qwen\\extension-store.",
      ),
    );
  });
}

function successfulQuery(
  getContextUsage: () => Promise<Record<string, unknown> | null> = async () =>
    null,
): Query {
  return fakeQuery(async function* () {
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
    } as SDKMessage;
  }, getContextUsage);
}

function usageQuery(): Query {
  return fakeQuery(
    async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hola.",
        usage: {
          input_tokens: 39_023,
          output_tokens: 196,
          total_tokens: 39_219,
        },
      } as SDKMessage;
    },
    async () => ({
      modelName: "qwen3.6-35b-a3b",
      totalTokens: 23_173,
      contextWindowSize: 262_144,
      isEstimated: false,
    }),
  );
}

function progressiveUsageQuery(): Query {
  return fakeQuery(async function* () {
    yield assistantUsageMessage("call-1", 10, 2);
    yield assistantUsageMessage("call-1", 10, 2);
    yield assistantUsageMessage("call-2", 20, 3);
    yield {
      ...resultMessage("done"),
      usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
    } as SDKMessage;
  });
}

function assistantUsageMessage(
  uuid: string,
  inputTokens: number,
  outputTokens: number,
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "session",
    parent_tool_use_id: null,
    message: {
      id: uuid,
      type: "message",
      role: "assistant",
      model: "qwen",
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  } as SDKMessage;
}

function assistantToolMessage(): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-tool-boundary",
    session_id: "session",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-boundary",
          name: "read_file",
          input: { file_path: "README.md" },
        },
      ],
    },
  } as SDKMessage;
}

function resultMessage(result: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
  } as SDKMessage;
}

function subagentLoopQuery(): Query {
  return fakeQuery(async function* () {
    yield {
      type: "assistant",
      uuid: "parent-agent-call",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "agent-1",
            name: "agent",
            input: {
              description: "Architecture analysis",
              subagent_type: "general-purpose",
            },
          },
        ],
      },
    } as SDKMessage;
    yield {
      type: "assistant",
      uuid: "child-read-call",
      session_id: "session",
      parent_tool_use_id: "agent-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "child-read",
            name: "read_file",
            input: { file_path: "package.json" },
          },
        ],
      },
    } as SDKMessage;
    yield {
      type: "user",
      session_id: "session",
      parent_tool_use_id: "agent-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "child-read",
            content: "package contents",
          },
        ],
      },
    } as SDKMessage;
    yield {
      type: "user",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-1",
            content: "child result",
          },
        ],
      },
    } as SDKMessage;
    yield {
      type: "assistant",
      uuid: "parent-final",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Parent summary" }],
      },
    } as SDKMessage;
    yield resultMessage("Parent summary");
  });
}

function runRequest() {
  return {
    prompt: "hello",
    workspacePath: "C:\\workspace",
    sessionId: "session",
    resume: false,
  };
}

function toolLoopQuery(): Query {
  return fakeQuery(async function* () {
    yield {
      type: "assistant",
      uuid: "assistant-tool",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { file_path: "README.md" },
          },
        ],
      },
    } as SDKMessage;
    yield {
      type: "user",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "README contents",
            is_error: false,
          },
        ],
      },
    } as SDKMessage;
    yield {
      type: "assistant",
      uuid: "assistant-final",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Project summary" }],
      },
    } as SDKMessage;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Project summary",
    } as SDKMessage;
  });
}

function cancellableQuery(
  options: QueryOptions | undefined,
  interrupt: ReturnType<typeof vi.fn<() => Promise<void>>>,
): Query {
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve, reject) => {
        rejectCancellation = reject;
        const signal = options?.abortController?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Operation aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Operation aborted", "AbortError")),
          { once: true },
        );
        if (signal === undefined) {
          resolve();
        }
      });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "unexpected",
      } as SDKMessage;
    },
    isClosed: () => false,
    close: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => {
      await interrupt();
      rejectCancellation?.(
        new DOMException("Operation interrupted", "AbortError"),
      );
    }),
  } as unknown as Query;
}

function fakeQuery(
  messages: () => AsyncGenerator<SDKMessage, void, unknown>,
  getContextUsage: () => Promise<Record<string, unknown> | null> = async () =>
    null,
): Query {
  return {
    [Symbol.asyncIterator]: messages,
    isClosed: () => true,
    close: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    getContextUsage,
  } as unknown as Query;
}
