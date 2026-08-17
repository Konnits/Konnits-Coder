import { describe, expect, it, vi } from "vitest";
import { KonnitsCommandRouter } from "../../src/commands/KonnitsCommandRouter.js";
import { registerKonnitsCommands } from "../../src/commands/KonnitsCommands.js";
import { SlashCommandRegistry } from "../../src/commands/SlashCommandRegistry.js";
import type { QwenSubagentDiagnostics } from "../../src/qwen/QwenSubagentRegistry.js";

const workspace = {
  workspacePath: "C:\\workspace",
  workspacePaths: ["C:\\workspace"],
};

describe("native Konnits commands", () => {
  it("builds /help from the same merged registry used by routing", async () => {
    const { router } = createNativeRouter();
    const route = await router.route("/help status", workspace);
    expect(route).toMatchObject({
      type: "local",
      result: {
        title: "/status",
        status: "success",
        markdown: expect.stringContaining("/status [detail]") as string,
      },
    });
  });

  it("lists actual shared-catalog agents and supports the list spelling", async () => {
    const list = vi.fn(async () => ({
      agents: [
        {
          name: "Explore",
          description: "Fast codebase exploration",
          systemPrompt: "Explore",
          level: "session" as const,
          isBuiltin: true,
        },
      ],
      diagnostics: diagnostics(),
    }));
    const { router } = createNativeRouter(list);

    for (const invocation of ["/agents", "/agents list"]) {
      const route = await router.route(invocation, workspace);
      expect(route.type === "local" && route.result.markdown).toContain(
        "Explore",
      );
    }
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps listing failures and unsupported management actions local", async () => {
    const list = vi.fn(async () => {
      throw new Error("daemon unavailable");
    });
    const { router } = createNativeRouter(list);

    const failed = await router.route("/agents", workspace);
    expect(failed).toMatchObject({
      type: "local",
      result: { status: "error" },
    });
    expect(failed.type === "local" && failed.result.markdown).toContain(
      "daemon unavailable",
    );

    const create = await router.route("/agents create", workspace);
    expect(create.type === "local" && create.result.markdown).toContain(
      "not exposed",
    );
  });
});

function createNativeRouter(
  list = vi.fn(async () => ({ diagnostics: diagnostics() })),
) {
  const registry = new SlashCommandRegistry({
    discover: vi.fn(async () => [
      {
        id: "qwen:status",
        command: "/status",
        title: "/status",
        description: "Show runtime status.",
        usage: "/status [detail]",
        source: "qwen" as const,
        origin: "qwen" as const,
        executionMode: "qwen-sdk" as const,
        available: true,
      },
    ]),
    refresh: vi.fn(),
  });
  registerKonnitsCommands(registry, { list });
  return { registry, router: new KonnitsCommandRouter(registry) };
}

function diagnostics(): QwenSubagentDiagnostics {
  return {
    workspacePath: "C:\\workspace",
    childWorkingDirectory: "C:\\workspace",
    childUserProfile: "profile",
    childHome: "home",
    userAgentDirectory: "agents",
    projectAgentDirectory: "project-agents",
    userAgentsDiscovered: [],
    projectAgentsDiscovered: [],
    builtInAgents: ["Explore"],
    agentToolAvailable: "unavailable",
    agentRuntimeAvailable: "yes",
    modelVisibleAgentNames: "unavailable",
    runtimeAgentNames: ["Explore"],
  };
}
