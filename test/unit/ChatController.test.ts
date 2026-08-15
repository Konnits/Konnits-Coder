import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentClient,
  AgentRunRequest,
} from "../../src/agent/AgentClient.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { TokenCounter } from "../../src/agent/TokenUsage.js";
import type { ChangeManager } from "../../src/changes/ChangeManager.js";
import type { DiffContentProvider } from "../../src/changes/DiffContentProvider.js";
import type { VsCodeFileSystem } from "../../src/changes/VsCodeFileSystem.js";
import type { Logger } from "../../src/logging/Logger.js";
import type { ModelManagement } from "../../src/models/ModelTypes.js";
import type { PermissionManager } from "../../src/permissions/PermissionManager.js";
import type { QwenSessionManager } from "../../src/qwen/QwenSessionManager.js";

vi.mock("vscode", () => ({
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: "C:\\workspace" } }],
  },
  Uri: {
    parse: (value: string) => ({
      scheme: /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1] ?? "",
      value,
    }),
  },
  env: { openExternal: vi.fn(async () => true) },
  window: {
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
  },
}));

describe("ChatController terminal states", () => {
  beforeEach(() => vi.resetModules());

  it("leaves running and reaches completed on agent completion", async () => {
    const { controller, agent } = await createController();

    agent.emit(startedEvent());
    expect(controller.getState().status).toBe("running");
    agent.emit({
      type: "agent.completed",
      runId: "run-1",
      result: "done",
      timestamp: Date.now(),
    });

    expect(controller.getState().status).toBe("completed");
    const response = controller
      .getState()
      .timeline.find((item) => item.type === "finalResponse");
    expect(response).toMatchObject({
      type: "finalResponse",
      id: "final-run-1",
      text: "done",
    });
    expect(
      response?.type === "finalResponse" && response.tokenCount?.accuracy,
    ).toBe("estimated");
  });

  it("marks an interrupted session resumable before accepting the next turn", async () => {
    const { controller, agent, markEstablished } = await createController();

    agent.emit(startedEvent());
    agent.emit(messageStarted("active-assistant"));
    agent.emit({
      type: "thinking.started",
      thoughtId: "active-thinking",
      timestamp: Date.now(),
    });
    agent.emit({
      type: "tool.started",
      callId: "active-tool",
      toolName: "read_file",
      kind: "read",
      title: "Read",
      timestamp: Date.now(),
    });
    agent.emit({
      type: "agent.cancelled",
      runId: "run-1",
      timestamp: Date.now(),
    });

    expect(markEstablished).toHaveBeenCalledWith("session-1");
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        id: "active-assistant",
        complete: true,
        cancelled: true,
      }),
    );
    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "thinking",
        id: "active-thinking",
        complete: true,
        cancelled: true,
      }),
    );
    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "tool",
        id: "active-tool",
        state: "cancelled",
      }),
    );
  });

  it("keeps preamble and tools out of the accumulated final response", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit(messageStarted("preamble"));
    agent.emit(messageChunk("preamble", "I will inspect the project."));
    agent.emit(messageCompleted("preamble"));
    agent.emit({
      type: "tool.started",
      callId: "tool-1",
      toolName: "read_file",
      kind: "read",
      title: "Read",
      detail: "C:\\workspace\\README.md",
      target: "C:\\workspace\\README.md",
      timestamp: Date.now(),
    });
    agent.emit({
      type: "tool.completed",
      callId: "tool-1",
      toolName: "read_file",
      kind: "read",
      title: "Read",
      detail: "C:\\workspace\\README.md",
      target: "C:\\workspace\\README.md",
      success: true,
      output: "file contents",
      timestamp: Date.now(),
    });
    agent.emit(messageStarted("final"));
    agent.emit(messageChunk("final", "## Result\n\n"));
    agent.emit(messageChunk("final", "**Complete**"));
    agent.emit(messageCompleted("final"));
    agent.emit({
      type: "agent.completed",
      runId: "run-1",
      result: "## Result\n\n**Complete**",
      timestamp: Date.now(),
    });

    const timeline = controller.getState().timeline;
    expect(timeline).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        id: "preamble",
        text: "I will inspect the project.",
      }),
    );
    expect(timeline).toContainEqual(
      expect.objectContaining({ type: "tool", id: "tool-1" }),
    );
    expect(timeline).toContainEqual(
      expect.objectContaining({
        type: "finalResponse",
        id: "final",
        text: "## Result\n\n**Complete**",
      }),
    );
    expect(
      timeline.filter((item) => item.type === "finalResponse"),
    ).toHaveLength(1);
  });

  it("keeps streamed thinking separate from the final response", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit({
      type: "thinking.started",
      thoughtId: "thought-1",
      timestamp: 1_000,
    });
    agent.emit({
      type: "thinking.chunk",
      thoughtId: "thought-1",
      text: "Private emitted reasoning",
      timestamp: 1_500,
    });
    agent.emit({
      type: "thinking.completed",
      thoughtId: "thought-1",
      durationMs: 2_000,
      timestamp: 3_000,
    });
    agent.emit({
      type: "agent.completed",
      runId: "run-1",
      result: "Visible result",
      timestamp: 4_000,
    });

    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "thinking",
        text: "Private emitted reasoning",
        complete: true,
        durationMs: 2_000,
      }),
    );
    const final = controller
      .getState()
      .timeline.find((item) => item.type === "finalResponse");
    expect(final).toMatchObject({ text: "Visible result" });
    expect(final?.type === "finalResponse" && final.text).not.toContain(
      "Private emitted reasoning",
    );
  });

  it("updates one authoritative turn-usage item progressively", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit(turnUsageEvent(10, 2));
    agent.emit(turnUsageEvent(30, 5));

    const items = controller
      .getState()
      .timeline.filter((item) => item.type === "turnUsage");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 5 },
    });
  });

  it("preserves subagent parent relationships without inventing usage", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit({
      type: "tool.started",
      callId: "agent-1",
      toolName: "agent",
      kind: "subagent",
      title: "Agent",
      detail: "Architecture analysis",
      subagentName: "general-purpose",
      timestamp: Date.now(),
    });
    agent.emit({
      type: "tool.started",
      callId: "child-read",
      toolName: "read_file",
      kind: "read",
      title: "Read",
      detail: "package.json",
      parentId: "agent-1",
      timestamp: Date.now(),
    });

    const child = controller
      .getState()
      .timeline.find(
        (item) => item.type === "tool" && item.id === "child-read",
      );
    expect(child).toMatchObject({ parentId: "agent-1" });
    expect(child).not.toHaveProperty("turnUsage");
  });

  it("leaves running and reaches failed with a visible error", async () => {
    const { controller, agent } = await createController();

    agent.emit(startedEvent());
    agent.emit({
      type: "agent.failed",
      runId: "run-1",
      message: "Qwen failed",
      timestamp: Date.now(),
    });

    const state = controller.getState();
    expect(state.status).toBe("failed");
    expect(state.timeline).toContainEqual(
      expect.objectContaining({ type: "error", message: "Qwen failed" }),
    );
  });

  it("opens only supported external link schemes", async () => {
    const vscode = await import("vscode");
    const { controller } = await createController();

    controller.handleMessage({
      type: "openExternal",
      href: "https://example.com/docs",
    });
    await vi.waitFor(() =>
      expect(vscode.env.openExternal).toHaveBeenCalledOnce(),
    );

    vi.mocked(vscode.env.openExternal).mockClear();
    controller.handleMessage({
      type: "openExternal",
      href: "javascript:alert(1)",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("updates context metadata without adding timeline entries", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    const before = controller.getState().timeline;

    agent.emit(contextEvent("session-1", 42_731));

    expect(controller.getState().timeline).toEqual(before);
    expect(controller.getState().contextUsage?.usedTokens).toBe(42_731);
  });

  it("accepts context decreases and ignores metrics from another session", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit(contextEvent("session-1", 80_000));
    agent.emit(contextEvent("session-1", 31_000));
    expect(controller.getState().contextUsage?.usedTokens).toBe(31_000);

    agent.emit(contextEvent("another-session", 99_000));
    expect(controller.getState().contextUsage?.usedTokens).toBe(31_000);
  });

  it("clears current context when a new session starts", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit(contextEvent("session-1", 42_731));
    agent.emit({
      type: "agent.cancelled",
      runId: "run-1",
      timestamp: Date.now(),
    });

    await controller.newSession();

    expect(controller.getState().sessionId).toBe("session-2");
    expect(controller.getState().contextUsage).toBeUndefined();
  });

  it("adds estimated visible-message counts without failing on counter errors", async () => {
    const working = await createController({
      count: () => ({ tokens: 18, accuracy: "estimated" }),
    });
    working.controller.handleMessage({ type: "sendPrompt", prompt: "hello" });
    await vi.waitFor(() =>
      expect(working.controller.getState().timeline).toContainEqual(
        expect.objectContaining({
          type: "user",
          tokenCount: { tokens: 18, accuracy: "estimated" },
        }),
      ),
    );

    const failing = await createController({
      count: () => {
        throw new Error("counter failed");
      },
    });
    failing.controller.handleMessage({ type: "sendPrompt", prompt: "hello" });
    await vi.waitFor(() =>
      expect(failing.controller.getState().timeline).toContainEqual(
        expect.objectContaining({ type: "user", text: "hello" }),
      ),
    );
    expect(failing.controller.getState().status).not.toBe("failed");
  });

  it("refreshes the secret-free model summary when the webview becomes ready", async () => {
    const models = fakeModelManagement({ modelChanged: false });
    const { controller } = await createController(undefined, models);

    controller.handleMessage({ type: "ready" });
    await vi.waitFor(() =>
      expect(controller.getState().model.label).toBe("Computer B"),
    );
    expect(models.loadState).toHaveBeenCalledOnce();
  });

  it("prevents model changes while Qwen is busy", async () => {
    const vscode = await import("vscode");
    const models = fakeModelManagement({ modelChanged: true });
    const { controller, agent } = await createController(undefined, models);
    agent.emit(startedEvent());

    await controller.manageModels();

    expect(models.showPicker).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Cancel the active Qwen operation before changing models.",
    );
  });

  it("starts a clean session and clears stale context after a model switch", async () => {
    const models = fakeModelManagement({ modelChanged: true });
    const { controller, agent } = await createController(undefined, models);
    agent.emit(startedEvent());
    agent.emit(contextEvent("session-1", 42_731));
    agent.emit(messageStarted("old-response"));
    agent.emit(messageChunk("old-response", "old context"));
    agent.emit({
      type: "agent.cancelled",
      runId: "run-1",
      timestamp: Date.now(),
    });

    await controller.manageModels();

    expect(controller.getState()).toMatchObject({
      sessionId: "session-2",
      model: { label: "Computer B" },
      timeline: [],
    });
    expect(controller.getState().contextUsage).toBeUndefined();
    expect(models.showPicker).toHaveBeenCalledOnce();
  });
});

async function createController(
  tokenCounter?: TokenCounter,
  models?: ModelManagement,
) {
  const { ChatController } = await import("../../src/chat/ChatController.js");
  const agent = new FakeAgentClient();
  const disposable = (): { dispose(): void } => ({ dispose: () => undefined });
  const markEstablished = vi.fn(async () => undefined);
  const sessions = {
    create: async () => ({ id: "session-2" }),
    getOrCreate: async () => ({
      session: { id: "session-1" },
      resume: false,
    }),
    markEstablished,
  } as unknown as QwenSessionManager;
  const controller = new ChatController(
    agent,
    sessions,
    {
      onDidChange: disposable,
      list: () => [],
      denyAll: () => undefined,
    } as unknown as PermissionManager,
    {
      onDidChange: disposable,
      list: () => [],
      clearSettled: () => undefined,
    } as unknown as ChangeManager,
    { displayPath: (uri: string) => uri } as unknown as VsCodeFileSystem,
    {} as DiffContentProvider,
    { debug: vi.fn(), error: vi.fn() } as unknown as Logger,
    tokenCounter,
    models,
  );
  return { controller, agent, sessions, markEstablished };
}

function fakeModelManagement(result: {
  readonly modelChanged: boolean;
}): ModelManagement & {
  readonly loadState: ReturnType<typeof vi.fn>;
  readonly showPicker: ReturnType<typeof vi.fn>;
} {
  return {
    loadState: vi.fn(async () => ({
      label: "Computer B",
      description: "http://computer-b:1234/v1",
      configuredCount: 2,
      credentialConfigured: true,
    })),
    showPicker: vi.fn(async () => result),
    addModel: vi.fn(async () => result),
    openSettings: vi.fn(async () => undefined),
  };
}

function contextEvent(sessionId: string, usedTokens: number): AgentEvent {
  return {
    type: "context.usage.updated",
    sessionId,
    usage: {
      usedTokens,
      contextWindowTokens: 262_144,
      remainingTokens: 262_144 - usedTokens,
      usedPercentage: (usedTokens / 262_144) * 100,
      accuracy: "exact",
    },
    timestamp: Date.now(),
  };
}

function startedEvent(): AgentEvent {
  return {
    type: "agent.started",
    runId: "run-1",
    sessionId: "session-1",
    timestamp: Date.now(),
  };
}

function messageStarted(messageId: string): AgentEvent {
  return {
    type: "assistant.message.started",
    messageId,
    timestamp: Date.now(),
  };
}

function messageChunk(messageId: string, text: string): AgentEvent {
  return {
    type: "assistant.message.chunk",
    messageId,
    text,
    timestamp: Date.now(),
  };
}

function messageCompleted(messageId: string): AgentEvent {
  return {
    type: "assistant.message.completed",
    messageId,
    timestamp: Date.now(),
  };
}

function turnUsageEvent(inputTokens: number, outputTokens: number): AgentEvent {
  return {
    type: "turn.usage.updated",
    runId: "run-1",
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: inputTokens + outputTokens,
      accuracy: "exact",
    },
    timestamp: Date.now(),
  };
}

class FakeAgentClient implements AgentClient {
  private listener: ((event: AgentEvent) => void) | undefined;

  connect(): Promise<void> {
    return Promise.resolve();
  }

  run(request: AgentRunRequest): Promise<void> {
    void request;
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  onEvent(listener: (event: AgentEvent) => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: () => (this.listener = undefined) };
  }

  emit(event: AgentEvent): void {
    this.listener?.(event);
  }
}
