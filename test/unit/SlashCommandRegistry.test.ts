import { describe, expect, it, vi } from "vitest";
import type { SlashCommandDescriptor } from "../../src/commands/SlashCommand.js";
import { SlashCommandRegistry } from "../../src/commands/SlashCommandRegistry.js";

const workspace = {
  workspacePath: "C:\\workspace",
  workspacePaths: ["C:\\workspace"],
};

describe("unified slash command registry", () => {
  it("merges dynamic Qwen commands with native and unavailable registrations", async () => {
    const discovery = fakeDiscovery([
      qwenCommand("/context", "Show context", "/context [detail]"),
      qwenCommand("/future", "Future runtime command"),
    ]);
    const registry = new SlashCommandRegistry(discovery);
    registry.registerNative({
      descriptor: nativeCommand("/help", "Show commands", "/help [command]"),
      handler: vi.fn(async () => ({
        command: "/help",
        title: "Help",
        markdown: "help",
        status: "success" as const,
      })),
    });
    registry.registerUnavailable({
      ...nativeCommand("/editor", "Set editor", "/editor"),
      id: "unavailable:editor",
      executionMode: "unavailable",
      available: false,
      reasonUnavailable: "Interactive only.",
    });

    await expect(registry.list(workspace)).resolves.toEqual([
      expect.objectContaining({
        command: "/context",
        source: "qwen",
        executionMode: "qwen-sdk",
        description: "Show context",
        usage: "/context [detail]",
      }),
      expect.objectContaining({
        command: "/editor",
        executionMode: "unavailable",
        available: false,
      }),
      expect.objectContaining({ command: "/future" }),
      expect.objectContaining({
        command: "/help",
        source: "konnits",
        executionMode: "konnits",
      }),
    ]);
  });

  it("gives native adapters priority and lets newly supported Qwen commands replace unavailable entries", async () => {
    const registry = new SlashCommandRegistry(
      fakeDiscovery([
        qwenCommand("/help", "Runtime help"),
        qwenCommand("/editor", "Runtime editor"),
      ]),
    );
    registry.registerUnavailable({
      ...nativeCommand("/editor", "Interactive editor"),
      id: "unavailable:editor",
      executionMode: "unavailable",
      available: false,
    });
    registry.registerNative({
      descriptor: nativeCommand("/help", "Native help"),
      handler: vi.fn(),
    });

    expect(
      (await registry.resolve("/help", workspace))?.descriptor,
    ).toMatchObject({
      description: "Native help",
      executionMode: "konnits",
    });
    expect(
      (await registry.resolve("/EDITOR", workspace))?.descriptor,
    ).toMatchObject({
      description: "Runtime editor",
      executionMode: "qwen-sdk",
      available: true,
    });
  });

  it("resolves normalized aliases and caches discovery until refresh", async () => {
    const discovery = fakeDiscovery([
      { ...qwenCommand("/compress", "Compress"), aliases: ["/summarize"] },
    ]);
    const registry = new SlashCommandRegistry(discovery);

    await registry.list(workspace);
    await expect(
      registry.resolve("summarize", workspace),
    ).resolves.toMatchObject({
      descriptor: { command: "/compress" },
    });
    expect(discovery.discover).toHaveBeenCalledOnce();

    registry.refresh();
    await registry.list(workspace);
    expect(discovery.refresh).toHaveBeenCalledOnce();
    expect(discovery.discover).toHaveBeenCalledTimes(2);
  });
});

function qwenCommand(
  command: string,
  description: string,
  usage?: string,
): SlashCommandDescriptor {
  return {
    id: `qwen:${command}`,
    command,
    title: command,
    description,
    ...(usage === undefined ? {} : { usage }),
    source: "qwen",
    origin: "builtin",
    executionMode: "qwen-sdk",
    available: true,
  };
}

function nativeCommand(
  command: string,
  description: string,
  usage = command,
): SlashCommandDescriptor {
  return {
    id: `konnits:${command}`,
    command,
    title: command,
    description,
    usage,
    source: "konnits",
    executionMode: "konnits",
    available: true,
  };
}

function fakeDiscovery(commands: readonly SlashCommandDescriptor[]) {
  return {
    discover: vi.fn(async () => commands),
    refresh: vi.fn(),
  };
}
