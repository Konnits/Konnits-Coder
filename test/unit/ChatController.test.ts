import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentClient,
  AgentRunRequest,
  AgentSessionRestoreRequest,
  AgentSessionRestoreResult,
} from "../../src/agent/AgentClient.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { TokenCounter } from "../../src/agent/TokenUsage.js";
import type { ChangeManager } from "../../src/changes/ChangeManager.js";
import type { ProposedFileChange } from "../../src/changes/ProposedFileChange.js";
import type { DiffContentProvider } from "../../src/changes/DiffContentProvider.js";
import type { VsCodeFileSystem } from "../../src/changes/VsCodeFileSystem.js";
import type { Logger } from "../../src/logging/Logger.js";
import type { ModelManagement } from "../../src/models/ModelTypes.js";
import type { PermissionManager } from "../../src/permissions/PermissionManager.js";
import type { QwenSessionManager } from "../../src/qwen/QwenSessionManager.js";
import { KonnitsCommandRouter } from "../../src/commands/KonnitsCommandRouter.js";
import { registerKonnitsCommands } from "../../src/commands/KonnitsCommands.js";
import { SlashCommandRegistry } from "../../src/commands/SlashCommandRegistry.js";
import type {
  QwenSavedSession,
  QwenSessionHistoryService,
} from "../../src/qwen/QwenSessionHistoryService.js";
import type {
  ChatReference,
  TimelineItem,
} from "../../src/webview/messages.js";
import type { ChatAttachmentAuthorization } from "../../src/chat/ChatAttachmentService.js";
import type { SessionRewind } from "../../src/qwen/QwenSessionRewindService.js";

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
  commands: { executeCommand: vi.fn(async () => undefined) },
  window: {
    createQuickPick: vi.fn(),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
  },
  ThemeIcon: class ThemeIcon {
    constructor(readonly id: string) {}
  },
}));

describe("ChatController terminal states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

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

  it("publishes root todo updates and clears them with the session", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());
    agent.emit({
      type: "todos.updated",
      todos: [
        { id: "one", content: "Inspect", status: "completed" },
        { id: "two", content: "Implement", status: "in_progress" },
      ],
      timestamp: Date.now(),
    });
    agent.emit({
      type: "todos.updated",
      todos: [{ id: "nested", content: "Nested work", status: "pending" }],
      parentId: "subagent-1",
      timestamp: Date.now(),
    });

    expect(controller.getState().todos).toEqual([
      { id: "one", content: "Inspect", status: "completed" },
      { id: "two", content: "Implement", status: "in_progress" },
    ]);

    agent.emit({
      type: "agent.cancelled",
      runId: "run-1",
      timestamp: Date.now(),
    });
    await controller.newSession();

    expect(controller.getState().todos).toEqual([]);
  });

  it("derives added, modified, and deleted badges from captured file existence", async () => {
    const now = Date.now();
    const proposal = (
      id: string,
      originalContent: string | null,
      proposedContent: string | null,
    ): ProposedFileChange => ({
      id,
      uri: `C:\\workspace\\${id}.ts`,
      originalContent,
      proposedContent,
      originalHash: null,
      proposedHash: null,
      status: "pending",
      additions: 1,
      deletions: 1,
      createdAt: now,
      updatedAt: now,
    });
    const { controller } = await createController(
      undefined,
      undefined,
      undefined,
      undefined,
      [
        proposal("added", null, "new"),
        proposal("modified", "old", "new"),
        proposal("deleted", "old", null),
      ],
    );

    expect(controller.getState().changes.map((change) => change.kind)).toEqual([
      "added",
      "modified",
      "deleted",
    ]);
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

  it("serializes selected references for Qwen while keeping visible text and metadata separate", async () => {
    const { controller, agent } = await createController();
    const reference: ChatReference = {
      id: "file:///C:/workspace/README.md",
      kind: "file",
      workspaceFolderUri: "[object Object]",
      uri: "file:///C:/workspace/README.md",
      relativePath: "README.md",
      displayName: "README.md",
    };

    controller.handleMessage({
      type: "sendPrompt",
      prompt: "explica la instalación",
      references: [reference],
    });

    await vi.waitFor(() => expect(agent.lastRequest).toBeDefined());
    expect(agent.lastRequest?.prompt).toBe("@README.md explica la instalación");
    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "user",
        text: "explica la instalación",
        references: [reference],
      }),
    );
  });

  it("queues a visible follow-up message while Qwen is working", async () => {
    const { controller, agent } = await createController();
    agent.emit(startedEvent());

    controller.handleMessage({
      type: "sendPrompt",
      prompt: "Prioriza las pruebas de integración",
    });

    await vi.waitFor(() =>
      expect(agent.sentMessages).toEqual([
        "Prioriza las pruebas de integración",
      ]),
    );
    expect(agent.lastRequest).toBeUndefined();
    expect(controller.getState().status).toBe("running");
    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "followUp",
        text: "Prioriza las pruebas de integración",
      }),
    );
  });

  it("retries a previous prompt as a new turn", async () => {
    const { controller, agent } = await createController();
    controller.handleMessage({ type: "sendPrompt", prompt: "Run checks" });
    await vi.waitFor(() => expect(agent.lastRequest).toBeDefined());
    const original = controller
      .getState()
      .timeline.find((item) => item.type === "user");
    if (original?.type !== "user") {
      throw new Error("Expected the original user prompt.");
    }
    agent.emit(startedEvent());
    agent.emit({
      type: "agent.completed",
      runId: "run-1",
      result: "done",
      timestamp: Date.now(),
    });
    agent.lastRequest = undefined;

    controller.handleMessage({ type: "retryPrompt", id: original.id });

    await vi.waitFor(() =>
      expect(agent.lastRequest?.prompt).toBe("Run checks"),
    );
    expect(
      controller
        .getState()
        .timeline.filter((item) => item.type === "user")
        .map((item) => item.text),
    ).toEqual(["Run checks", "Run checks"]);
  });

  it("rewinds Qwen, restores files, and removes later turns when editing a prompt", async () => {
    const rewindCall = vi.fn(async () => undefined);
    const rewind: SessionRewind = { rewind: rewindCall };
    const working = await createController(
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      rewind,
    );
    working.controller.handleMessage({
      type: "sendPrompt",
      prompt: "Original request",
    });
    await vi.waitFor(() => expect(working.agent.lastRequest).toBeDefined());
    const original = working.controller
      .getState()
      .timeline.find((item) => item.type === "user");
    if (original?.type !== "user") throw new Error("Expected user prompt");
    working.agent.emit(startedEvent());
    working.agent.emit({
      type: "agent.completed",
      runId: "run-1",
      result: "first done",
      timestamp: Date.now(),
    });
    working.agent.lastRequest = undefined;
    working.controller.handleMessage({
      type: "sendPrompt",
      prompt: "Later request",
    });
    await vi.waitFor(() => expect(working.agent.lastRequest).toBeDefined());
    working.agent.emit(startedEvent());
    working.agent.emit({
      type: "agent.completed",
      runId: "run-2",
      result: "second done",
      timestamp: Date.now(),
    });
    working.agent.lastRequest = undefined;
    working.controller.handleMessage({
      type: "editPrompt",
      id: original.id,
      prompt: "Edited request",
    });

    await vi.waitFor(() =>
      expect(working.agent.lastRequest?.prompt).toBe("Edited request"),
    );
    expect(rewindCall).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspacePath: "C:\\workspace",
      targetTurnIndex: 0,
    });
    expect(working.changeSpies.restoreCheckpoint).toHaveBeenCalledWith(
      original.id,
    );
    expect(
      working.controller
        .getState()
        .timeline.filter((item) => item.type === "user")
        .map((item) => item.text),
    ).toEqual(["Edited request"]);
  });

  it("restores prompt files without changing conversation history", async () => {
    const vscode = await import("vscode");
    const working = await createController();
    working.controller.handleMessage({ type: "sendPrompt", prompt: "Change" });
    await vi.waitFor(() => expect(working.agent.lastRequest).toBeDefined());
    const user = working.controller
      .getState()
      .timeline.find((item) => item.type === "user");
    if (user?.type !== "user") throw new Error("Expected user prompt");
    working.changeSpies.hasChangesSinceCheckpoint.mockReturnValue(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      "Restore files" as never,
    );

    working.controller.handleMessage({
      type: "restorePromptFiles",
      id: user.id,
    });

    await vi.waitFor(() =>
      expect(working.changeSpies.restoreCheckpoint).toHaveBeenCalledWith(
        user.id,
      ),
    );
    expect(
      working.controller
        .getState()
        .timeline.filter((item) => item.type === "user"),
    ).toHaveLength(1);
  });

  it("returns files to their newer state when Qwen conversation rewind fails", async () => {
    const vscode = await import("vscode");
    const rewind: SessionRewind = {
      rewind: vi.fn(async () => {
        throw new Error("snapshot compacted");
      }),
    };
    const working = await createController(
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      rewind,
    );
    working.controller.handleMessage({
      type: "sendPrompt",
      prompt: "Original",
    });
    await vi.waitFor(() => expect(working.agent.lastRequest).toBeDefined());
    const user = working.controller
      .getState()
      .timeline.find((item) => item.type === "user");
    if (user?.type !== "user") throw new Error("Expected user prompt");
    working.agent.emit(startedEvent());
    working.agent.emit({
      type: "agent.completed",
      runId: "run-1",
      result: "done",
      timestamp: Date.now(),
    });

    working.controller.handleMessage({
      type: "editPrompt",
      id: user.id,
      prompt: "Edited",
    });

    await vi.waitFor(() =>
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "snapshot compacted",
      ),
    );
    const restoredIds = working.changeSpies.restoreCheckpoint.mock.calls.map(
      ([checkpointId]) => checkpointId,
    );
    expect(restoredIds[0]).toBe(user.id);
    expect(restoredIds[1]).toMatch(/^edit-rollback:/u);
    expect(
      working.controller
        .getState()
        .timeline.filter((item) => item.type === "user"),
    ).toHaveLength(1);
  });

  it("opens the scoped agent permission setting", async () => {
    const vscode = await import("vscode");
    const { controller } = await createController();

    controller.handleMessage({ type: "openPermissionSettings" });

    await vi.waitFor(() =>
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "@ext:Konnits.konnits-coder qwenFrontend.qwen.permissionMode",
      ),
    );
  });

  it("adds the controlled attachment directory to the Qwen workspace context", async () => {
    const attachment: ChatReference = {
      id: "file:///C:/attachments/image.png",
      kind: "file",
      workspaceFolderUri: "file:///C:/attachments",
      uri: "file:///C:/attachments/image.png",
      relativePath: "image.png",
      displayName: "image.png",
      source: "attachment",
    };
    const authorization: ChatAttachmentAuthorization = {
      isManaged: () => true,
      additionalWorkspacePaths: () => ["C:\\attachments"],
    };
    const { controller, agent } = await createController(
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      authorization,
    );

    controller.handleMessage({
      type: "sendPrompt",
      prompt: "Describe this image",
      references: [attachment],
    });

    await vi.waitFor(() => expect(agent.lastRequest).toBeDefined());
    expect(agent.lastRequest?.workspacePaths).toEqual([
      "C:\\workspace",
      "C:\\attachments",
    ]);
    expect(agent.lastRequest?.prompt).toContain("image.png");
  });

  it("rejects attachment references that were not issued by the attachment service", async () => {
    const forgedAttachment: ChatReference = {
      id: "file:///C:/outside/secret.txt",
      kind: "file",
      workspaceFolderUri: "file:///C:/outside",
      uri: "file:///C:/outside/secret.txt",
      relativePath: "secret.txt",
      displayName: "secret.txt",
      source: "attachment",
    };
    const authorization: ChatAttachmentAuthorization = {
      isManaged: () => false,
      additionalWorkspacePaths: () => [],
    };
    const { controller, agent } = await createController(
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      authorization,
    );

    controller.handleMessage({
      type: "sendPrompt",
      prompt: "Read this",
      references: [forgedAttachment],
    });

    await vi.waitFor(() =>
      expect(controller.getState().timeline.at(-1)).toMatchObject({
        type: "error",
        message: "That attachment is no longer available.",
      }),
    );
    expect(agent.lastRequest).toBeUndefined();
    expect(controller.getState().status).toBe("idle");
  });

  it("routes native, unavailable, and unknown commands locally before any Qwen turn", async () => {
    const registry = new SlashCommandRegistry({
      discover: vi.fn(async () => [
        {
          id: "qwen:status",
          command: "/status",
          title: "/status",
          description: "Runtime status",
          source: "qwen" as const,
          origin: "qwen" as const,
          executionMode: "qwen-sdk" as const,
          available: true,
        },
      ]),
      refresh: vi.fn(),
    });
    registerKonnitsCommands(registry, {
      list: vi.fn(async () => ({
        agents: [
          {
            name: "Explore",
            description: "Fast codebase exploration",
            systemPrompt: "Explore",
            level: "session" as const,
          },
        ],
        diagnostics: {
          workspacePath: "C:\\workspace",
          childWorkingDirectory: "C:\\workspace",
          childUserProfile: "profile",
          childHome: "home",
          userAgentDirectory: "agents",
          projectAgentDirectory: "project-agents",
          userAgentsDiscovered: [],
          projectAgentsDiscovered: [],
          builtInAgents: [],
          agentToolAvailable: "unavailable" as const,
          agentRuntimeAvailable: "yes" as const,
          modelVisibleAgentNames: "unavailable" as const,
          runtimeAgentNames: ["Explore"],
        },
      })),
    });
    const { controller, agent } = await createController(
      undefined,
      undefined,
      undefined,
      new KonnitsCommandRouter(registry),
    );

    for (const prompt of ["/help", "/agents", "/editor", "/noexiste"]) {
      const previousLength = controller.getState().timeline.length;
      controller.handleMessage({ type: "sendPrompt", prompt });
      await vi.waitFor(() =>
        expect(controller.getState().timeline.length).toBe(previousLength + 1),
      );
      expect(controller.getState().timeline.at(-1)).toMatchObject({
        type: "commandResult",
      });
    }
    expect(agent.lastRequest).toBeUndefined();
    expect(controller.getState().timeline).toContainEqual(
      expect.objectContaining({
        type: "commandResult",
        command: "/agents",
        markdown: expect.stringContaining("Explore") as string,
      }),
    );

    controller.handleMessage({ type: "sendPrompt", prompt: "/status" });
    await vi.waitFor(() => expect(agent.lastRequest?.prompt).toBe("/status"));
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

  it("browses history without inference and protects the current item", async () => {
    const vscode = await import("vscode");
    const current = savedSession("session-current", "C:\\workspace", true);
    const inactive = savedSession("session-old", "C:\\workspace", false);
    const history = fakeHistory([current, inactive]);
    const picker = new FakeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValue(picker as never);
    const { controller, agent } = await createController(
      undefined,
      undefined,
      history.service,
    );

    await controller.openHistory();

    expect(picker.shown).toBe(true);
    expect(picker.items).toHaveLength(2);
    expect(picker.items[0]?.buttons).toBeUndefined();
    expect(picker.items[1]?.buttons).toHaveLength(1);
    expect(agent.lastRequest).toBeUndefined();
    expect(agent.restoreRequest).toBeUndefined();
    expect(history.loadTranscript).not.toHaveBeenCalled();
  });

  it("resumes the matching canonical workspace and restores display state without a fake prompt", async () => {
    const vscode = await import("vscode");
    setWorkspaceFolders(vscode, ["C:\\first", "C:\\SECOND"]);
    const session = savedSession("session-old", "c:/second", false);
    const history = fakeHistory([session]);
    history.loadTranscript.mockResolvedValue([
      { type: "user", id: "old-user", text: "Old request" },
      { type: "finalResponse", id: "old-final", text: "Old response" },
    ]);
    const picker = new FakeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValue(picker as never);
    const models = fakeModelManagement({ modelChanged: false });
    const { controller, agent, resumeExisting } = await createController(
      undefined,
      models,
      history.service,
    );
    agent.restoreResult = {
      contextUsage: {
        usedTokens: 12,
        contextWindowTokens: 100,
        remainingTokens: 88,
        usedPercentage: 12,
        accuracy: "exact",
      },
    };

    await controller.openHistory();
    picker.selectedItems = [picker.items[0]!];
    picker.triggerAccept();

    await vi.waitFor(() =>
      expect(agent.restoreRequest).toEqual({
        sessionId: "session-old",
        workspacePath: "C:\\SECOND",
      }),
    );
    expect(agent.lastRequest).toBeUndefined();
    expect(resumeExisting).toHaveBeenCalledWith("session-old");
    expect(controller.getState()).toMatchObject({
      sessionId: "session-old",
      contextUsage: { usedTokens: 12 },
      timeline: [
        { type: "user", id: "old-user", text: "Old request" },
        { type: "finalResponse", id: "old-final", text: "Old response" },
      ],
      model: { label: "Computer B" },
    });
  });

  it("requires confirmation, refreshes after deletion, and keeps failed deletions visible", async () => {
    const vscode = await import("vscode");
    const session = savedSession("session-old", "C:\\workspace", false);
    const history = fakeHistory([session]);
    const picker = new FakeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValue(picker as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      "Delete" as never,
    );
    const { controller } = await createController(
      undefined,
      undefined,
      history.service,
    );
    await controller.openHistory();

    picker.triggerItemButton(picker.items[0]!);

    await vi.waitFor(() =>
      expect(history.delete).toHaveBeenCalledWith(session),
    );
    expect(history.list).toHaveBeenCalledTimes(2);

    const failedHistory = fakeHistory([session]);
    failedHistory.delete.mockRejectedValue(new Error("locked"));
    const failedPicker = new FakeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValue(
      failedPicker as never,
    );
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      "Delete" as never,
    );
    const failed = await createController(
      undefined,
      undefined,
      failedHistory.service,
    );
    await failed.controller.openHistory();

    failedPicker.triggerItemButton(failedPicker.items[0]!);

    await vi.waitFor(() =>
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "Unable to delete Qwen conversation: locked",
      ),
    );
    expect(failedHistory.list).toHaveBeenCalledOnce();
    expect(failedPicker.items).toHaveLength(1);
  });

  it("clears inactive workspace history only after confirmation", async () => {
    const vscode = await import("vscode");
    setWorkspaceFolders(vscode, ["C:\\workspace"]);
    const sessions = [
      savedSession("session-1", "C:\\workspace", true),
      savedSession("session-old", "C:\\workspace", false),
    ];
    const history = fakeHistory(sessions);
    const picker = new FakeQuickPick();
    vi.mocked(vscode.window.createQuickPick).mockReturnValue(picker as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      "Clear" as never,
    );
    const { controller } = await createController(
      undefined,
      undefined,
      history.service,
    );
    await controller.openHistory();

    picker.triggerButton();

    await vi.waitFor(() =>
      expect(history.deleteInactive).toHaveBeenCalledWith(
        ["C:\\workspace"],
        "session-1",
      ),
    );
    expect(history.list).toHaveBeenCalledTimes(2);
  });
});

async function createController(
  tokenCounter?: TokenCounter,
  models?: ModelManagement,
  history?: QwenSessionHistoryService,
  commands?: KonnitsCommandRouter,
  proposedChanges: readonly ProposedFileChange[] = [],
  attachments?: ChatAttachmentAuthorization,
  sessionRewind?: SessionRewind,
) {
  const { ChatController } = await import("../../src/chat/ChatController.js");
  const agent = new FakeAgentClient();
  const disposable = (): { dispose(): void } => ({ dispose: () => undefined });
  const markEstablished = vi.fn(async () => undefined);
  const resumeExisting = vi.fn(async (sessionId: string) => ({
    session: { id: sessionId },
    resume: true,
  }));
  const checkpointIds = new Set<string>();
  const restoreCheckpoint = vi.fn(async (id: string) => {
    void id;
  });
  const hasChangesSinceCheckpoint = vi.fn(() => false);
  const changeManager = {
    onDidChange: disposable,
    list: () => proposedChanges,
    denyAll: () => undefined,
    clearSettled: () => undefined,
    captureCheckpoint: vi.fn(async (id: string) => {
      checkpointIds.add(id);
    }),
    hasCheckpoint: vi.fn((id: string) => checkpointIds.has(id)),
    hasChangesSinceCheckpoint,
    assertCheckpointRestorable: vi.fn(async () => undefined),
    restoreCheckpoint,
    discardCheckpoints: vi.fn((ids: readonly string[]) => {
      for (const id of ids) checkpointIds.delete(id);
    }),
    clearCheckpoints: vi.fn(() => checkpointIds.clear()),
  } as unknown as ChangeManager;
  const sessions = {
    create: async () => ({ id: "session-2" }),
    getOrCreate: async () => ({
      session: { id: "session-1" },
      resume: false,
    }),
    markEstablished,
    getKnownSessionId: () => "session-1",
    resumeExisting,
  } as unknown as QwenSessionManager;
  const controller = new ChatController(
    agent,
    sessions,
    {
      onDidChange: disposable,
      list: () => [],
      denyAll: () => undefined,
    } as unknown as PermissionManager,
    changeManager,
    { displayPath: (uri: string) => uri } as unknown as VsCodeFileSystem,
    {} as DiffContentProvider,
    { debug: vi.fn(), error: vi.fn() } as unknown as Logger,
    tokenCounter,
    models,
    history,
    commands,
    attachments,
    sessionRewind,
  );
  return {
    controller,
    agent,
    sessions,
    markEstablished,
    resumeExisting,
    changeSpies: { restoreCheckpoint, hasChangesSinceCheckpoint },
  };
}

interface FakeHistoryPickerItem {
  readonly session: QwenSavedSession;
  readonly buttons?: readonly unknown[];
}

class FakeQuickPick {
  title: string | undefined;
  placeholder: string | undefined;
  matchOnDescription = false;
  matchOnDetail = false;
  busy = false;
  buttons: readonly unknown[] = [];
  items: readonly FakeHistoryPickerItem[] = [];
  selectedItems: readonly FakeHistoryPickerItem[] = [];
  shown = false;
  disposed = false;
  private accept: (() => void) | undefined;
  private itemButton:
    | ((event: { readonly item: FakeHistoryPickerItem }) => void)
    | undefined;
  private button: (() => void) | undefined;
  private hideListener: (() => void) | undefined;

  onDidAccept(listener: () => void): { dispose(): void } {
    this.accept = listener;
    return { dispose: () => undefined };
  }

  onDidTriggerItemButton(
    listener: (event: { readonly item: FakeHistoryPickerItem }) => void,
  ): { dispose(): void } {
    this.itemButton = listener;
    return { dispose: () => undefined };
  }

  onDidTriggerButton(listener: () => void): { dispose(): void } {
    this.button = listener;
    return { dispose: () => undefined };
  }

  onDidHide(listener: () => void): { dispose(): void } {
    this.hideListener = listener;
    return { dispose: () => undefined };
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.shown = false;
    this.hideListener?.();
  }

  dispose(): void {
    this.disposed = true;
  }

  triggerAccept(): void {
    this.accept?.();
  }

  triggerItemButton(item: FakeHistoryPickerItem): void {
    this.itemButton?.({ item });
  }

  triggerButton(): void {
    this.button?.();
  }
}

function savedSession(
  sessionId: string,
  cwd: string,
  isCurrent: boolean,
): QwenSavedSession {
  return {
    sessionId,
    title: sessionId,
    cwd,
    updatedAt: 1,
    isCurrent,
    transcriptPath: `C:\\qwen\\chats\\${sessionId}.jsonl`,
  };
}

function fakeHistory(sessions: readonly QwenSavedSession[]) {
  const list = vi.fn(async () => sessions);
  const loadTranscript = vi.fn(
    async (): Promise<readonly TimelineItem[]> => [],
  );
  const deleteSession = vi.fn(async () => undefined);
  const deleteInactive = vi.fn(async () => ({
    removed: sessions
      .filter((session) => !session.isCurrent)
      .map((session) => session.sessionId),
    errors: [],
  }));
  return {
    service: {
      list,
      loadTranscript,
      delete: deleteSession,
      deleteInactive,
    } as unknown as QwenSessionHistoryService,
    list,
    loadTranscript,
    delete: deleteSession,
    deleteInactive,
  };
}

function setWorkspaceFolders(
  vscode: typeof import("vscode"),
  paths: readonly string[],
): void {
  (
    vscode.workspace as unknown as {
      workspaceFolders: readonly {
        readonly uri: { readonly fsPath: string };
      }[];
    }
  ).workspaceFolders = paths.map((fsPath) => ({ uri: { fsPath } }));
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
  lastRequest: AgentRunRequest | undefined;
  restoreRequest: AgentSessionRestoreRequest | undefined;
  restoreResult: AgentSessionRestoreResult = {};
  readonly sentMessages: string[] = [];

  connect(): Promise<void> {
    return Promise.resolve();
  }

  run(request: AgentRunRequest): Promise<void> {
    this.lastRequest = request;
    return Promise.resolve();
  }

  sendMessage(message: string): Promise<boolean> {
    this.sentMessages.push(message);
    return Promise.resolve(true);
  }

  restoreSession(
    request: AgentSessionRestoreRequest,
  ): Promise<AgentSessionRestoreResult> {
    this.restoreRequest = request;
    return Promise.resolve(this.restoreResult);
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
