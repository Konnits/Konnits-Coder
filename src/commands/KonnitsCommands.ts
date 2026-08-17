import type { SubagentConfig } from "@qwen-code/sdk";
import type { QwenSubagentResolution } from "../qwen/QwenSubagentRegistry.js";
import type {
  NativeCommandResult,
  ParsedSlashCommand,
  SlashCommandDescriptor,
} from "./SlashCommand.js";
import type { SlashCommandRegistry } from "./SlashCommandRegistry.js";

export interface QwenAgentCatalog {
  list(workspacePath: string): Promise<QwenSubagentResolution>;
}

export function registerKonnitsCommands(
  registry: SlashCommandRegistry,
  agents: QwenAgentCatalog,
): void {
  registry.registerNative({
    descriptor: {
      id: "konnits:help",
      command: "/help",
      title: "/help",
      description: "Show commands currently known to Konnits-Coder.",
      usage: "/help [command]",
      aliases: ["/?"],
      source: "konnits",
      origin: "builtin",
      executionMode: "konnits",
      available: true,
    },
    handler: (command, context) =>
      Promise.resolve(helpResult(command, context.commands)),
  });
  registry.registerNative({
    descriptor: {
      id: "konnits:agents",
      command: "/agents",
      title: "/agents",
      description: "List the Qwen subagents available in this workspace.",
      usage: "/agents [list]",
      source: "konnits",
      origin: "builtin",
      executionMode: "konnits",
      available: true,
    },
    handler: async (command, context) => {
      if (context.workspacePath === undefined) {
        return commandError(
          command,
          "Open a workspace folder to list Qwen agents.",
        );
      }
      const action = command.args[0]?.toLowerCase() ?? "list";
      if (action !== "list") {
        return commandError(
          command,
          "This Konnits-Coder version supports `/agents` and `/agents list`. Agent create, edit, and delete are not exposed because the native management workflow is not implemented.",
        );
      }
      try {
        return agentsResult(command, await agents.list(context.workspacePath));
      } catch (error) {
        return commandError(
          command,
          `Unable to list Qwen agents: ${toErrorMessage(error)}`,
        );
      }
    },
  });

  registry.registerUnavailable({
    id: "unavailable:editor",
    command: "/editor",
    title: "/editor",
    description: "Set the external editor used by interactive Qwen Code.",
    usage: "/editor",
    source: "konnits",
    origin: "builtin",
    executionMode: "unavailable",
    available: false,
    reasonUnavailable:
      "This command requires the interactive Qwen CLI and is not currently supported by Konnits-Coder.",
  });
}

function helpResult(
  invocation: ParsedSlashCommand,
  commands: readonly SlashCommandDescriptor[],
): NativeCommandResult {
  const requested = invocation.args[0]?.replace(/^\/+/, "").toLowerCase();
  if (requested !== undefined) {
    const descriptor = commands.find(
      (candidate) =>
        candidate.command.slice(1).toLowerCase() === requested ||
        candidate.aliases?.some(
          (alias) => alias.replace(/^\/+/, "").toLowerCase() === requested,
        ) === true,
    );
    if (descriptor === undefined) {
      return commandError(
        invocation,
        `No command named \`/${escapeMarkdown(requested)}\` is currently registered.`,
      );
    }
    return {
      command: invocation.raw,
      title: descriptor.command,
      markdown: formatCommandHelp(descriptor),
      status: descriptor.available ? "success" : "error",
    };
  }

  const rows = commands.map((command) => {
    const availability = command.available
      ? command.executionMode === "konnits"
        ? "Konnits"
        : "Qwen SDK"
      : "Unavailable";
    return `| \`${escapeMarkdown(command.command)}\` | ${escapeTable(command.description)} | ${availability} |`;
  });
  return {
    command: invocation.raw,
    title: "Available commands",
    markdown: [
      "Commands are generated from the unified Konnits registry for this workspace.",
      "",
      "| Command | Description | Execution |",
      "| --- | --- | --- |",
      ...rows,
      "",
      "Use `/help <command>` for usage and aliases.",
    ].join("\n"),
    status: "success",
  };
}

function formatCommandHelp(command: SlashCommandDescriptor): string {
  return [
    command.description,
    "",
    `**Usage:** \`${escapeMarkdown(command.usage ?? command.command)}\``,
    ...(command.aliases === undefined || command.aliases.length === 0
      ? []
      : [
          "",
          `**Aliases:** ${command.aliases.map((alias) => `\`${escapeMarkdown(alias)}\``).join(", ")}`,
        ]),
    "",
    `**Execution:** ${command.available ? (command.executionMode === "konnits" ? "Konnits native" : "Qwen SDK") : "Unavailable"}`,
    ...(command.reasonUnavailable === undefined
      ? []
      : ["", command.reasonUnavailable]),
  ].join("\n");
}

function agentsResult(
  invocation: ParsedSlashCommand,
  resolution: QwenSubagentResolution,
): NativeCommandResult {
  if (resolution.diagnostics.error !== undefined) {
    return commandError(invocation, resolution.diagnostics.error);
  }
  const agents = resolution.agents ?? [];
  return {
    command: invocation.raw,
    title: "Qwen agents",
    markdown:
      agents.length === 0
        ? "Qwen reported no agents for this workspace."
        : [
            `Qwen reported ${String(agents.length)} available agent${agents.length === 1 ? "" : "s"}:`,
            "",
            ...agents.map(formatAgent),
          ].join("\n"),
    status: "success",
  };
}

function formatAgent(agent: SubagentConfig): string {
  return `- **${escapeMarkdown(agent.name)}**${agent.isBuiltin ? " (built-in)" : ""} — ${escapeMarkdown(agent.description)}`;
}

function commandError(
  invocation: ParsedSlashCommand,
  markdown: string,
): NativeCommandResult {
  return {
    command: invocation.raw,
    title: `${invocation.command} unavailable`,
    markdown,
    status: "error",
  };
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("`", "\\`");
}

function escapeTable(value: string): string {
  return escapeMarkdown(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
