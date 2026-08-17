import { describe, expect, it, vi } from "vitest";
import { KonnitsCommandRouter } from "../../src/commands/KonnitsCommandRouter.js";
import type { SlashCommandDescriptor } from "../../src/commands/SlashCommand.js";
import { SlashCommandRegistry } from "../../src/commands/SlashCommandRegistry.js";

const workspace = {
  workspacePath: "C:\\workspace",
  workspacePaths: ["C:\\workspace"],
};

describe("Konnits command router", () => {
  it("routes normal prompts and supported runtime commands to Qwen", async () => {
    const { router } = createRouter([qwenCommand("/context")]);

    await expect(
      router.route("Explain the project", workspace),
    ).resolves.toEqual({
      type: "prompt",
    });
    await expect(
      router.route("/context detail", workspace),
    ).resolves.toMatchObject({
      type: "qwen",
      command: { command: "/context", args: ["detail"] },
    });
  });

  it("executes native commands locally", async () => {
    const { registry, router } = createRouter([]);
    const handler = vi.fn(async () => ({
      command: "/help",
      title: "Commands",
      markdown: "Local help",
      status: "success" as const,
    }));
    registry.registerNative({
      descriptor: nativeCommand("/help"),
      handler,
    });

    await expect(router.route("/help", workspace)).resolves.toEqual({
      type: "local",
      result: {
        command: "/help",
        title: "Commands",
        markdown: "Local help",
        status: "success",
      },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps known unavailable and unknown commands local", async () => {
    const { registry, router } = createRouter([qwenCommand("/context")]);
    registry.registerUnavailable({
      ...nativeCommand("/editor"),
      id: "unavailable:editor",
      executionMode: "unavailable",
      available: false,
      reasonUnavailable: "Only the interactive Qwen CLI can run this command.",
    });

    await expect(router.route("/editor", workspace)).resolves.toMatchObject({
      type: "local",
      result: {
        title: "/editor is unavailable",
        status: "error",
        markdown: "Only the interactive Qwen CLI can run this command.",
      },
    });
    const unknown = await router.route("/contex", workspace);
    expect(unknown).toMatchObject({
      type: "local",
      result: { title: "Unknown command: /contex", status: "error" },
    });
    expect(unknown.type === "local" && unknown.result.markdown).toContain(
      "/context",
    );
  });
});

function createRouter(commands: readonly SlashCommandDescriptor[]) {
  const registry = new SlashCommandRegistry({
    discover: vi.fn(async () => commands),
    refresh: vi.fn(),
  });
  return { registry, router: new KonnitsCommandRouter(registry) };
}

function qwenCommand(command: string): SlashCommandDescriptor {
  return {
    id: `qwen:${command}`,
    command,
    title: command,
    description: "Runtime command",
    source: "qwen",
    executionMode: "qwen-sdk",
    available: true,
  };
}

function nativeCommand(command: string): SlashCommandDescriptor {
  return {
    id: `konnits:${command}`,
    command,
    title: command,
    description: "Native command",
    source: "konnits",
    executionMode: "konnits",
    available: true,
  };
}
