import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectQwenRuntime } from "../../src/qwen/QwenRuntimeDiagnostics.js";
import { resolveQwenSubagents } from "../../src/qwen/QwenSubagentRegistry.js";

const liveIt = process.env.QWEN_LIVE_TEST === "1" ? it : it.skip;

describe("Qwen subagent registry live integration", () => {
  liveIt(
    "lists agents through the Windows Electron daemon launch branch",
    { timeout: 60_000 },
    async () => {
      const runtime = await inspectQwenRuntime();
      const resolution = await resolveQwenSubagents(runtime, process.cwd(), {
        platform: "win32",
        electronVersion: process.versions.electron ?? "test-electron",
        launcherPath: join(process.cwd(), "dist", "qwen-cli-launcher.mjs"),
      });

      expect(resolution.diagnostics.error).toBeUndefined();
      expect(resolution.diagnostics.agentRuntimeAvailable).toBe("yes");
      expect(resolution.diagnostics.runtimeAgentNames).not.toBe("unavailable");
      expect(resolution.agents?.length ?? 0).toBeGreaterThan(0);
    },
  );
});
