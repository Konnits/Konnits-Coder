import { describe, expect, it, vi } from "vitest";
import {
  formatQwenSubagentDiagnostics,
  QwenSubagentCatalog,
  resolveQwenDaemonLaunch,
  type QwenSubagentDiagnostics,
} from "../../src/qwen/QwenSubagentRegistry.js";

describe("Qwen subagent diagnostics", () => {
  it("does not spawn an mjs launcher directly on Windows Electron", () => {
    const launch = resolveQwenDaemonLaunch("C:\\qwen\\cli.js", {
      platform: "win32",
      electronVersion: "42.0.0",
      launcherPath: "C:\\extension\\qwen-cli-launcher.mjs",
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["C:\\extension\\qwen-cli-launcher.mjs"]);
    expect(launch.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      QWEN_FRONTEND_CLI_TARGET: "C:\\qwen\\cli.js",
    });
  });

  it("shares and refreshes cached daemon discovery by runtime and workspace", async () => {
    const diagnostics = diagnosticFixture();
    const resolution = { diagnostics };
    const runtimeResolver = vi.fn(
      async () =>
        ({
          cliExecutable: "C:\\qwen\\cli.js",
        }) as never,
    );
    const resolver = vi.fn(async () => resolution);
    const catalog = new QwenSubagentCatalog(
      () => ({ executablePath: "C:\\qwen\\cli.js" }),
      runtimeResolver,
      resolver,
    );

    await catalog.list("C:\\workspace");
    await catalog.list("C:\\workspace");
    expect(resolver).toHaveBeenCalledOnce();
    catalog.refresh();
    await catalog.list("C:\\workspace");
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed daemon resolution", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce({
        diagnostics: {
          ...diagnosticFixture(),
          error: "spawn EFTYPE",
        },
      })
      .mockResolvedValueOnce({ diagnostics: diagnosticFixture() });
    const catalog = new QwenSubagentCatalog(
      () => ({}),
      async () => ({ cliExecutable: "C:\\qwen\\cli.js" }) as never,
      resolver,
    );

    expect((await catalog.list("C:\\workspace")).diagnostics.error).toBe(
      "spawn EFTYPE",
    );
    expect(
      (await catalog.list("C:\\workspace")).diagnostics.error,
    ).toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an empty runtime from unavailable introspection", () => {
    const diagnostics: QwenSubagentDiagnostics = {
      workspacePath: "C:\\workspace",
      childWorkingDirectory: "C:\\workspace",
      childUserProfile: "C:\\Users\\test",
      childHome: "C:\\Users\\test",
      userAgentDirectory: "C:\\Users\\test\\.qwen\\agents",
      projectAgentDirectory: "C:\\workspace\\.qwen\\agents",
      userAgentsDiscovered: [],
      projectAgentsDiscovered: [],
      builtInAgents: ["general-purpose", "Explore"],
      agentToolAvailable: "yes",
      agentRuntimeAvailable: "yes",
      modelVisibleAgentNames: ["general-purpose", "Explore"],
      runtimeAgentNames: ["general-purpose", "Explore"],
    };

    const output = formatQwenSubagentDiagnostics(diagnostics).join("\n");

    expect(output).toContain("Built-in agents: general-purpose, Explore");
    expect(output).toContain("Agent runtime available: yes");
    expect(output).not.toContain("unavailable");
  });

  it("reports unavailable categories without inventing names", () => {
    const diagnostics: QwenSubagentDiagnostics = {
      workspacePath: "C:\\workspace",
      childWorkingDirectory: "C:\\workspace",
      childUserProfile: "unavailable",
      childHome: "unavailable",
      userAgentDirectory: "C:\\Users\\test\\.qwen\\agents",
      projectAgentDirectory: "C:\\workspace\\.qwen\\agents",
      userAgentsDiscovered: [],
      projectAgentsDiscovered: [],
      builtInAgents: "unavailable",
      agentToolAvailable: "unavailable",
      agentRuntimeAvailable: "unavailable",
      modelVisibleAgentNames: "unavailable",
      runtimeAgentNames: "unavailable",
      error: "Qwen agent registry discovery unavailable",
    };

    const output = formatQwenSubagentDiagnostics(diagnostics).join("\n");

    expect(output).toContain("Built-in agents: unavailable");
    expect(output).toContain(
      "Subagent names available to runtime: unavailable",
    );
    expect(output).toContain("Qwen agent registry discovery unavailable");
  });
});

function diagnosticFixture(): QwenSubagentDiagnostics {
  return {
    workspacePath: "C:\\workspace",
    childWorkingDirectory: "C:\\workspace",
    childUserProfile: "profile",
    childHome: "home",
    userAgentDirectory: "agents",
    projectAgentDirectory: "project-agents",
    userAgentsDiscovered: [],
    projectAgentsDiscovered: [],
    builtInAgents: [],
    agentToolAvailable: "unavailable",
    agentRuntimeAvailable: "yes",
    modelVisibleAgentNames: "unavailable",
    runtimeAgentNames: [],
  };
}
