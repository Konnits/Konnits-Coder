import type {
  NativeCommandResult,
  ParsedSlashCommand,
  SlashCommandDescriptor,
  SlashCommandWorkspace,
} from "./SlashCommand.js";
import { parseSlashCommand } from "./SlashCommandParser.js";
import type { SlashCommandRegistry } from "./SlashCommandRegistry.js";

export type CommandRoute =
  | { readonly type: "prompt" }
  | {
      readonly type: "qwen";
      readonly command: ParsedSlashCommand;
      readonly descriptor: SlashCommandDescriptor;
    }
  | { readonly type: "local"; readonly result: NativeCommandResult };

export class KonnitsCommandRouter {
  constructor(private readonly registry: SlashCommandRegistry) {}

  async route(
    input: string,
    workspace: SlashCommandWorkspace,
  ): Promise<CommandRoute> {
    const parsed = parseSlashCommand(input);
    if (parsed === undefined) {
      return { type: "prompt" };
    }

    const commands = await this.registry.list(workspace);
    const resolved = await this.registry.resolve(parsed.command, workspace);
    if (resolved === undefined) {
      return {
        type: "local",
        result: unknownCommandResult(parsed, commands),
      };
    }

    const descriptor = resolved.descriptor;
    if (descriptor.executionMode === "unavailable" || !descriptor.available) {
      return {
        type: "local",
        result: {
          command: parsed.raw,
          title: `${descriptor.command} is unavailable`,
          markdown:
            descriptor.reasonUnavailable ??
            "This command is not available in Konnits-Coder.",
          status: "error",
        },
      };
    }
    if (descriptor.executionMode === "qwen-sdk") {
      return { type: "qwen", command: parsed, descriptor };
    }
    if (resolved.handler === undefined) {
      return {
        type: "local",
        result: {
          command: parsed.raw,
          title: `${descriptor.command} is unavailable`,
          markdown: "Konnits-Coder has no handler registered for this command.",
          status: "error",
        },
      };
    }

    try {
      return {
        type: "local",
        result: await resolved.handler(parsed, { ...workspace, commands }),
      };
    } catch (error) {
      return {
        type: "local",
        result: {
          command: parsed.raw,
          title: `${descriptor.command} failed`,
          markdown: error instanceof Error ? error.message : String(error),
          status: "error",
        },
      };
    }
  }
}

function unknownCommandResult(
  command: ParsedSlashCommand,
  commands: readonly SlashCommandDescriptor[],
): NativeCommandResult {
  const suggestions = findSuggestions(command.command, commands);
  return {
    command: command.raw,
    title: `Unknown command: ${command.command}`,
    markdown:
      suggestions.length === 0
        ? `Konnits-Coder does not recognize \`${command.command}\`.`
        : `Konnits-Coder does not recognize \`${command.command}\`.\n\nDid you mean ${suggestions.map((candidate) => `\`${candidate}\``).join(", ")}?`,
    status: "error",
  };
}

function findSuggestions(
  query: string,
  commands: readonly SlashCommandDescriptor[],
): readonly string[] {
  const normalizedQuery = query.slice(1).toLowerCase();
  return commands
    .map((command) => ({
      command: command.command,
      score: similarityScore(
        normalizedQuery,
        command.command.slice(1).toLowerCase(),
      ),
    }))
    .filter((candidate) => candidate.score <= 3)
    .sort(
      (left, right) =>
        left.score - right.score || left.command.localeCompare(right.command),
    )
    .slice(0, 3)
    .map((candidate) => candidate.command);
}

function similarityScore(left: string, right: string): number {
  if (right.startsWith(left) || left.startsWith(right)) {
    return Math.abs(left.length - right.length);
  }
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] ?? rightIndex - 1) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? rightIndex) + 1,
        (current[rightIndex - 1] ?? leftIndex) + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}
