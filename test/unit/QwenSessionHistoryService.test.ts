import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  chooseSessionTitle,
  normalizeWorkspacePath,
  parseSessionListJsonLines,
  QwenSessionHistoryService,
  type QwenCliExecutor,
  type QwenSavedSession,
} from "../../src/qwen/QwenSessionHistoryService.js";
import { normalizeQwenTranscript } from "../../src/qwen/QwenTranscriptLoader.js";

describe("Qwen session history", () => {
  it("parses JSONL defensively, filters by workspace, and sorts newest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "konnits-history-list-test-"));
    try {
      const workspace = join(root, "workspace");
      const otherWorkspace = join(root, "other");
      await mkdir(workspace, { recursive: true });
      const currentId = "11111111-1111-4111-8111-111111111111";
      const olderId = "22222222-2222-4222-8222-222222222222";
      const outsideId = "33333333-3333-4333-8333-333333333333";
      const stdout = [
        JSON.stringify({
          sessionId: olderId,
          startTime: "2026-08-15T00:00:00.000Z",
          mtime: 10,
          prompt: "older",
          filePath: join(root, `${olderId}.jsonl`),
          cwd: workspace,
        }),
        JSON.stringify({
          sessionId: currentId,
          startTime: "2026-08-16T00:00:00.000Z",
          mtime: 20,
          prompt: "current",
          filePath: join(root, `${currentId}.jsonl`),
          cwd: workspace,
        }),
        JSON.stringify({
          sessionId: outsideId,
          mtime: 30,
          prompt: "outside",
          filePath: join(root, `${outsideId}.jsonl`),
          cwd: otherWorkspace,
        }),
        "not json",
      ].join("\n");
      const executor = vi.fn<QwenCliExecutor>(async () => ({
        stdout,
        stderr: "",
      }));
      const service = new QwenSessionHistoryService(
        () => ({ debug: false }),
        { debug: vi.fn(), error: vi.fn() },
        async () => ({ cliExecutable: "qwen.cmd" }) as never,
        executor,
      );

      const sessions = await service.list([workspace], currentId);

      expect(sessions.map((session) => session.sessionId)).toEqual([
        currentId,
        olderId,
      ]);
      expect(sessions[0]?.isCurrent).toBe(true);
      const invocation = executor.mock.calls[0];
      expect(invocation?.[2]).toMatchObject({ cwd: workspace });
      expect(invocation?.[1].join(" ")).toContain(
        "sessions list --json --limit 1000",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only the selected transcript and Qwen-owned sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "konnits-history-delete-test-"));
    const previousQwenHome = process.env.QWEN_HOME;
    const qwenHome = join(root, "qwen");
    process.env.QWEN_HOME = qwenHome;
    try {
      const sessionId = "44444444-4444-4444-8444-444444444444";
      const project = join(root, "project");
      const chats = join(project, "chats");
      const archive = join(chats, "archive");
      const transcriptPath = join(chats, `${sessionId}.jsonl`);
      await mkdir(archive, { recursive: true });
      await mkdir(join(qwenHome, "file-history", sessionId), {
        recursive: true,
      });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ sessionId, cwd: project, type: "user" })}\n`,
      );
      await writeFile(join(archive, `${sessionId}.jsonl`), "archived\n");
      await writeFile(join(chats, `${sessionId}.worktree.json`), "active\n");
      await writeFile(join(archive, `${sessionId}.worktree.json`), "archive\n");
      await writeFile(
        join(qwenHome, "file-history", sessionId, "backup"),
        "file\n",
      );
      await writeFile(
        join(project, "session-organization.v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          groups: [],
          sessions: { [sessionId]: { groupId: null, updatedAt: "now" } },
        }),
      );
      const session: QwenSavedSession = {
        sessionId,
        title: "Delete me",
        cwd: project,
        updatedAt: 1,
        isCurrent: false,
        transcriptPath,
      };
      const service = new QwenSessionHistoryService(() => ({ debug: false }), {
        debug: vi.fn(),
        error: vi.fn(),
      });

      await service.delete(session);

      await expect(stat(transcriptPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        stat(join(archive, `${sessionId}.jsonl`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(chats, `${sessionId}.worktree.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(qwenHome, "file-history", sessionId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const organization: unknown = JSON.parse(
        await readFile(join(project, "session-organization.v1.json"), "utf8"),
      );
      expect(
        (organization as { readonly sessions: Record<string, unknown> })
          .sessions,
      ).not.toHaveProperty(sessionId);
    } finally {
      if (previousQwenHome === undefined) {
        delete process.env.QWEN_HOME;
      } else {
        process.env.QWEN_HOME = previousQwenHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears only inactive sessions from the requested workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "konnits-history-clear-test-"));
    const previousQwenHome = process.env.QWEN_HOME;
    const qwenHome = join(root, "qwen");
    process.env.QWEN_HOME = qwenHome;
    try {
      const workspace = join(root, "workspace");
      const unrelatedWorkspace = join(root, "unrelated");
      const chats = join(qwenHome, "projects", "workspace", "chats");
      const unrelatedChats = join(qwenHome, "projects", "unrelated", "chats");
      await mkdir(workspace, { recursive: true });
      await mkdir(unrelatedWorkspace, { recursive: true });
      await mkdir(chats, { recursive: true });
      await mkdir(unrelatedChats, { recursive: true });
      const currentId = "66666666-6666-4666-8666-666666666666";
      const inactiveId = "77777777-7777-4777-8777-777777777777";
      const unrelatedId = "88888888-8888-4888-8888-888888888888";
      const currentPath = join(chats, `${currentId}.jsonl`);
      const inactivePath = join(chats, `${inactiveId}.jsonl`);
      const unrelatedPath = join(unrelatedChats, `${unrelatedId}.jsonl`);
      await writeTranscript(currentPath, currentId, workspace);
      await writeTranscript(inactivePath, inactiveId, workspace);
      await writeTranscript(unrelatedPath, unrelatedId, unrelatedWorkspace);
      const executor = vi.fn<QwenCliExecutor>(async () => ({
        stdout: [
          sessionListEntry(currentId, currentPath, workspace, 30),
          sessionListEntry(inactiveId, inactivePath, workspace, 20),
          sessionListEntry(unrelatedId, unrelatedPath, unrelatedWorkspace, 10),
        ].join("\n"),
        stderr: "",
      }));
      const service = new QwenSessionHistoryService(
        () => ({ debug: false }),
        { debug: vi.fn(), error: vi.fn() },
        async () => ({ cliExecutable: "qwen.cmd" }) as never,
        executor,
      );

      const result = await service.deleteInactive([workspace], currentId);

      expect(result).toEqual({ removed: [inactiveId], errors: [] });
      await expect(stat(inactivePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(currentPath)).resolves.toBeDefined();
      await expect(stat(unrelatedPath)).resolves.toBeDefined();
    } finally {
      if (previousQwenHome === undefined) {
        delete process.env.QWEN_HOME;
      } else {
        process.env.QWEN_HOME = previousQwenHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failed deletion without claiming the session was removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "konnits-history-failure-test-"));
    try {
      const workspace = join(root, "workspace");
      const chats = join(root, "qwen", "projects", "workspace", "chats");
      const sessionId = "99999999-9999-4999-8999-999999999999";
      const transcriptPath = join(chats, `${sessionId}.jsonl`);
      await mkdir(workspace, { recursive: true });
      await mkdir(chats, { recursive: true });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ sessionId: "wrong-session", cwd: workspace })}\n`,
      );
      const executor = vi.fn<QwenCliExecutor>(async () => ({
        stdout: sessionListEntry(sessionId, transcriptPath, workspace, 10),
        stderr: "",
      }));
      const service = new QwenSessionHistoryService(
        () => ({ debug: false }),
        { debug: vi.fn(), error: vi.fn() },
        async () => ({ cliExecutable: "qwen.cmd" }) as never,
        executor,
      );

      const result = await service.deleteInactive([workspace]);

      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([expect.objectContaining({ sessionId })]);
      await expect(stat(transcriptPath)).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes titles and platform-specific workspace paths", () => {
    expect(
      chooseSessionTitle({
        sessionId: "abcdef12-0000-4000-8000-000000000000",
        customTitle: "  Custom title  ",
        prompt: "ignored",
      }),
    ).toBe("Custom title");
    expect(
      chooseSessionTitle({
        sessionId: "abcdef12-0000-4000-8000-000000000000",
        prompt: "  fix   the   login\nflow ",
      }),
    ).toBe("fix the login flow");
    expect(
      normalizeWorkspacePath("C:\\Users\\Example\\Project\\", "win32"),
    ).toBe(normalizeWorkspacePath("c:/users/example/project", "win32"));
    expect(parseSessionListJsonLines("{}\nnot-json\n")).toEqual([]);
  });
});

async function writeTranscript(
  path: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ sessionId, cwd, type: "user" })}\n`,
  );
}

function sessionListEntry(
  sessionId: string,
  filePath: string,
  cwd: string,
  mtime: number,
): string {
  return JSON.stringify({ sessionId, filePath, cwd, mtime });
}

describe("Qwen transcript normalization", () => {
  it("restores display data without executing historical tool calls", () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const source = [
      {
        uuid: "user-record",
        sessionId,
        type: "user",
        message: { role: "user", parts: [{ text: "Inspect the app" }] },
      },
      {
        uuid: "assistant-record",
        sessionId,
        type: "assistant",
        timestamp: "2026-08-16T00:00:00.000Z",
        message: {
          role: "model",
          parts: [
            { text: "I will inspect it.", thought: true },
            {
              functionCall: {
                id: "call-1",
                name: "read_file",
                args: { path: "src/app.ts" },
              },
            },
          ],
        },
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
          totalTokenCount: 17,
        },
      },
      {
        sessionId,
        type: "tool_result",
        toolCallResult: {
          callId: "call-1",
          status: "success",
          resultDisplay: "contents",
        },
      },
      {
        uuid: "final-record",
        sessionId,
        type: "assistant",
        message: { role: "model", parts: [{ text: "The app is ready." }] },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    const timeline = normalizeQwenTranscript(source, sessionId);

    expect(
      timeline.some(
        (item) => item.type === "user" && item.text === "Inspect the app",
      ),
    ).toBe(true);
    expect(
      timeline.some((item) => item.type === "thinking" && item.complete),
    ).toBe(true);
    expect(
      timeline.some(
        (item) =>
          item.type === "tool" &&
          item.id === "call-1" &&
          item.state === "succeeded" &&
          item.output === "contents",
      ),
    ).toBe(true);
    const final = timeline.find((item) => item.type === "finalResponse");
    expect(final?.type === "finalResponse" ? final.text : undefined).toBe(
      "The app is ready.",
    );
    expect(
      final?.type === "finalResponse" ? final.turnUsage : undefined,
    ).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 17,
      accuracy: "exact",
    });
  });
});
