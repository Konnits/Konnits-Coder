import { describe, expect, it, vi } from "vitest";
import type { Query, QueryOptions, SDKMessage } from "@qwen-code/sdk";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import { PermissionManager } from "../../src/permissions/PermissionManager.js";
import {
  QwenCodeAgentClient,
  describeSdkMessageForDebug,
  isQwenManagedMemoryTarget,
  resolveCliLaunch,
  type QwenChangeTracker,
  type QwenQueryFactory,
  type QwenSubagentResolver,
} from "../../src/qwen/QwenCodeAgentClient.js";
import type { QwenSubagentResolution } from "../../src/qwen/QwenSubagentRegistry.js";

describe("QwenCodeAgentClient", () => {
  it("recognizes only Qwen-managed memory files as external tracking exceptions", () => {
    const qwenDirectory = "C:\\Users\\test\\.qwen";

    expect(
      isQwenManagedMemoryTarget(
        "C:\\Users\\test\\.qwen\\memories\\user\\topic.md",
        qwenDirectory,
      ),
    ).toBe(true);
    expect(
      isQwenManagedMemoryTarget(
        "C:\\Users\\test\\.qwen\\settings.json",
        qwenDirectory,
      ),
    ).toBe(false);
    expect(
      isQwenManagedMemoryTarget(
        "C:\\Users\\test\\project\\README.md",
        qwenDirectory,
      ),
    ).toBe(false);
  });

  it("allows Qwen-managed memory edits without adding workspace change tracking", async () => {
    const previousQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = "C:\\qwen-home";
    try {
      const memoryTarget = "C:\\qwen-home\\memories\\user\\doctoral-thesis.md";
      const requests: Parameters<QwenQueryFactory>[0][] = [];
      const permissions = new PermissionManager();
      const beforeEdit = vi.fn(async () => undefined);
      const afterEdit = vi.fn(async () => undefined);
      const changes: QwenChangeTracker = {
        beforeEdit,
        afterEdit,
        completeAll: vi.fn(async () => undefined),
      };
      const client = new QwenCodeAgentClient(
        () => ({ debug: false }),
        permissions,
        changes,
        {
          debug: vi.fn<(message: string) => void>(),
          info: vi.fn<(message: string) => void>(),
          error: vi.fn<(message: string, error?: unknown) => void>(),
        },
        vi.fn(((request) => {
          requests.push(request);
          return memoryEditQuery(memoryTarget);
        }) as QwenQueryFactory),
      );

      await client.run(runRequest());

      expect(afterEdit).not.toHaveBeenCalled();
      const candidate = requests[0]?.options?.canUseTool as unknown;
      if (!isToolPermissionCallback(candidate)) {
        throw new Error("Expected a Qwen tool permission callback.");
      }
      const decision = candidate(
        "write_file",
        { file_path: memoryTarget },
        { signal: new AbortController().signal },
      );
      const permission = permissions.list()[0];
      if (permission === undefined) {
        throw new Error("Expected a pending memory edit permission.");
      }
      permissions.resolve(permission.id, "allow");

      await expect(decision).resolves.toMatchObject({ behavior: "allow" });
      expect(beforeEdit).not.toHaveBeenCalled();
    } finally {
      if (previousQwenHome === undefined) {
        delete process.env.QWEN_HOME;
      } else {
        process.env.QWEN_HOME = previousQwenHome;
      }
    }
  });

  it("denies an external edit when its scoped authorization is declined", async () => {
    const target = "C:\\Users\\test\\.ensemble-agent\\config.toml";
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const permissions = new PermissionManager();
    const beforeEdit = vi.fn(async () => {
      throw new Error(`The user declined external edit access for: ${target}`);
    });
    const client = new QwenCodeAgentClient(
      () => ({ debug: false }),
      permissions,
      {
        beforeEdit,
        afterEdit: vi.fn(async () => undefined),
        completeAll: vi.fn(async () => undefined),
      },
      {
        debug: vi.fn<(message: string) => void>(),
        info: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string, error?: unknown) => void>(),
      },
      vi.fn(((request) => {
        requests.push(request);
        return successfulQuery();
      }) as QwenQueryFactory),
    );

    await client.run(runRequest());

    const candidate = requests[0]?.options?.canUseTool as unknown;
    if (!isToolPermissionCallback(candidate)) {
      throw new Error("Expected a Qwen tool permission callback.");
    }
    const decision = candidate(
      "write_file",
      { file_path: target },
      { signal: new AbortController().signal },
    );
    const permission = permissions.list()[0];
    if (permission === undefined) {
      throw new Error("Expected a pending external edit permission.");
    }
    permissions.resolve(permission.id, "allow");

    const result = await decision;
    expect(isDeniedToolPermissionDecision(result)).toBe(true);
    if (!isDeniedToolPermissionDecision(result)) {
      throw new Error("Expected the external edit to be denied.");
    }
    expect(result.message).toContain("declined external edit access");
    expect(beforeEdit).toHaveBeenCalledWith(target);
  });

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

  it("streams follow-up messages into the active SDK query", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    let releaseQuery: (() => void) | undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const client = createClient(
      vi.fn(((request) => {
        requests.push(request);
        return fakeQuery(async function* () {
          await queryGate;
          yield resultMessage("done");
        });
      }) as QwenQueryFactory),
    );

    const run = client.run(runRequest());
    await expect(client.sendMessage("Queued immediately")).resolves.toBe(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const prompt = requests[0]?.prompt;
    if (typeof prompt === "string" || prompt === undefined) {
      throw new Error("Expected an active SDK user-message stream.");
    }
    const iterator = prompt[Symbol.asyncIterator]();
    const initial = await iterator.next();
    if (initial.done) {
      throw new Error("Expected the initial prompt message.");
    }
    expect(initial.value.message.content).toBe("hello");

    const queued = await iterator.next();
    if (queued.done) {
      throw new Error("Expected the queued prompt message.");
    }
    expect(queued.value.message.content).toBe("Queued immediately");

    await expect(client.sendMessage("Change course")).resolves.toBe(true);
    const followUp = await iterator.next();
    if (followUp.done) {
      throw new Error("Expected the active follow-up message.");
    }
    expect(followUp.value.message.content).toBe("Change course");

    releaseQuery?.();
    await run;
    await expect(client.sendMessage("Too late")).resolves.toBe(false);
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

  it("passes the safe plan permission mode to Qwen", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const client = createClient(
      vi.fn(((request) => {
        requests.push(request);
        return successfulQuery();
      }) as QwenQueryFactory),
      { permissionMode: "plan" },
    );

    await client.run(runRequest());

    expect(requests[0]?.options?.permissionMode).toBe("plan");
  });

  it("passes the acknowledged full-access mode to Qwen", async () => {
    const requests: Parameters<QwenQueryFactory>[0][] = [];
    const client = createClient(
      vi.fn(((request) => {
        requests.push(request);
        return successfulQuery();
      }) as QwenQueryFactory),
      { permissionMode: "yolo" },
    );

    await client.run(runRequest());

    expect(requests[0]?.options?.permissionMode).toBe("yolo");
  });

  it("denies image reads by default before Qwen can add them to the model input", async () => {
    const options: QueryOptions[] = [];
    const client = createClient(
      vi.fn(((request: { readonly options?: QueryOptions }) => {
        options.push(request.options ?? {});
        return successfulQuery();
      }) as QwenQueryFactory),
    );

    await client.run(runRequest());

    const candidate = options[0]?.canUseTool as unknown;
    if (!isToolPermissionCallback(candidate)) {
      throw new Error("Expected a Qwen tool permission callback.");
    }
    const decision = await candidate(
      "read_file",
      { file_path: "outputs/hard_mixed_multivariate.png" },
      { signal: new AbortController().signal },
    );
    expect(isDeniedToolPermissionDecision(decision)).toBe(true);
    if (!isDeniedToolPermissionDecision(decision)) {
      throw new Error("Expected a denied tool permission decision.");
    }
    expect(decision.message).toContain("Image input is disabled");
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

  it("does not track a completed external read as a workspace edit", async () => {
    const afterEdit = vi.fn(async () => {
      throw new Error("External reads must not enter change tracking.");
    });
    const client = new QwenCodeAgentClient(
      () => ({ debug: false }),
      new PermissionManager(),
      {
        beforeEdit: vi.fn(async () => undefined),
        afterEdit,
        completeAll: vi.fn(async () => undefined),
      },
      {
        debug: vi.fn<(message: string) => void>(),
        info: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string, error?: unknown) => void>(),
      },
      vi.fn((() =>
        toolLoopQuery(
          "C:\\Users\\test\\AppData\\Local\\qwen-code\\README.md",
        )) as QwenQueryFactory),
    );
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    await client.run(runRequest());

    expect(afterEdit).not.toHaveBeenCalled();
    expect(events).toContain("agent.completed");
    expect(events).not.toContain("agent.failed");
  });

  it("continues tracking completed workspace edits", async () => {
    const afterEdit = vi.fn(async () => undefined);
    const client = new QwenCodeAgentClient(
      () => ({ debug: false }),
      new PermissionManager(),
      {
        beforeEdit: vi.fn(async () => undefined),
        afterEdit,
        completeAll: vi.fn(async () => undefined),
      },
      {
        debug: vi.fn<(message: string) => void>(),
        info: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string, error?: unknown) => void>(),
      },
      vi.fn((() => memoryEditQuery("src/app.ts")) as QwenQueryFactory),
    );

    await client.run(runRequest());

    expect(afterEdit).toHaveBeenCalledOnce();
    expect(afterEdit).toHaveBeenCalledWith("src/app.ts");
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

  it("fails and closes a turn when Qwen stops yielding messages", async () => {
    const close = vi.fn(async () => undefined);
    const stalledQuery = {
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        return {
          next: () => new Promise<IteratorResult<SDKMessage>>(() => undefined),
        };
      },
      close,
      isClosed: () => false,
    } as unknown as Query;
    const client = createClient(
      vi.fn((() => stalledQuery) as QwenQueryFactory),
      { streamIdleTimeoutMs: 10 },
    );
    const events: AgentEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.run(runRequest());

    const failure = events.find((event) => event.type === "agent.failed");
    expect(failure?.type === "agent.failed" && failure.message).toContain(
      "stopped receiving messages for 10 ms",
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "agent.completed" }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a slow turn alive when the stream idle timeout is disabled", async () => {
    const query = fakeQuery(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield resultMessage("done");
    });
    const client = createClient(vi.fn((() => query) as QwenQueryFactory), {
      streamIdleTimeoutMs: 0,
    });
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    await client.run(runRequest());

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
  configuration: {
    readonly executablePath?: string;
    readonly allowImageInput?: boolean;
    readonly streamIdleTimeoutMs?: number;
    readonly permissionMode?: "default" | "plan" | "yolo";
  } = {},
  subagentResolver?: QwenSubagentResolver,
): QwenCodeAgentClient {
  return new QwenCodeAgentClient(
    () => ({ ...configuration, debug: false, allowImageInput: false }),
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

type ToolPermissionCallback = (
  toolName: string,
  input: { readonly file_path: string },
  context: { readonly signal: AbortSignal },
) => Promise<unknown>;

function isToolPermissionCallback(
  value: unknown,
): value is ToolPermissionCallback {
  return typeof value === "function";
}

function isDeniedToolPermissionDecision(
  value: unknown,
): value is { readonly behavior: "deny"; readonly message: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const decision = value as {
    readonly behavior?: unknown;
    readonly message?: unknown;
  };
  return decision.behavior === "deny" && typeof decision.message === "string";
}

function toolLoopQuery(target = "README.md"): Query {
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
            input: { file_path: target },
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

function memoryEditQuery(memoryTarget: string): Query {
  return fakeQuery(async function* () {
    yield {
      type: "assistant",
      uuid: "assistant-memory-edit",
      session_id: "session",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "memory-edit",
            name: "write_file",
            input: { file_path: memoryTarget, content: "updated memory" },
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
            tool_use_id: "memory-edit",
            content: "Updated memory",
            is_error: false,
          },
        ],
      },
    } as SDKMessage;
    yield resultMessage("Memory updated");
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
