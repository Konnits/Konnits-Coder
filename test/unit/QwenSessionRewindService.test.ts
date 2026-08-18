import { describe, expect, it, vi } from "vitest";
import { QwenSessionRewindService } from "../../src/qwen/QwenSessionRewindService.js";

describe("QwenSessionRewindService", () => {
  it("loads the session and rewinds conversation without letting Qwen restore files", async () => {
    const close = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const loadSession = vi.fn(async () => ({}));
    const getRewindSnapshots = vi.fn(async () => ({
      snapshots: [
        {
          promptId: "prompt-2",
          turnIndex: 1,
          timestamp: "2026-08-17T00:00:00.000Z",
          diffStats: { filesChanged: 2, insertions: 5, deletions: 1 },
        },
      ],
    }));
    const rewindSession = vi.fn(async () => ({
      rewound: true,
      targetTurnIndex: 1,
    }));
    const service = new QwenSessionRewindService(
      () => ({ executablePath: "qwen" }),
      vi.fn(async () => ({
        sdkVersion: "0.1.8",
        sdkRoot: "C:\\sdk",
        cliSource: "configured" as const,
        cliExecutable: "C:\\qwen\\cli.js",
        cliVersion: "0.19.10",
        settingsPath: "C:\\.qwen\\settings.json",
        credentialConfigured: false,
        secrets: [],
        warnings: [],
      })),
      vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4170", close })),
      () => ({
        loadSession,
        getRewindSnapshots,
        rewindSession,
        dispose,
      }),
    );

    await service.rewind({
      sessionId: "session-1",
      workspacePath: "C:\\workspace",
      targetTurnIndex: 1,
    });

    expect(loadSession).toHaveBeenCalledWith("session-1", {
      workspaceCwd: "C:\\workspace",
    });
    expect(rewindSession).toHaveBeenCalledWith("session-1", "prompt-2", {
      rewindFiles: false,
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails safely when Qwen no longer exposes the target snapshot", async () => {
    const close = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const service = new QwenSessionRewindService(
      () => ({}),
      vi.fn(async () => ({
        sdkVersion: "0.1.8",
        sdkRoot: "C:\\sdk",
        cliSource: "bundled" as const,
        cliExecutable: "C:\\qwen\\cli.js",
        cliVersion: "0.19.10",
        settingsPath: "C:\\.qwen\\settings.json",
        credentialConfigured: false,
        secrets: [],
        warnings: [],
      })),
      vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4170", close })),
      () => ({
        loadSession: vi.fn(async () => ({})),
        getRewindSnapshots: vi.fn(async () => ({ snapshots: [] })),
        rewindSession: vi.fn(),
        dispose,
      }),
    );

    await expect(
      service.rewind({
        sessionId: "session-1",
        workspacePath: "C:\\workspace",
        targetTurnIndex: 4,
      }),
    ).rejects.toThrow("can no longer rewind");
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
