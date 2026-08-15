import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { query, type Query, type QueryOptions } from "@qwen-code/sdk";
import type { QwenClientConfiguration } from "./QwenCodeAgentClient.js";
import {
  inspectQwenRuntime,
  type QwenRuntimeDiagnostics,
} from "./QwenRuntimeDiagnostics.js";
import { resolveCliLaunch } from "./QwenCodeAgentClient.js";
import type { SlashCommandSuggestion } from "../webview/messages.js";

export interface QwenCommandLogger {
  debug(message: string): void;
  error(message: string, error?: unknown): void;
}

export type QwenCommandQueryFactory = typeof query;
export type QwenRuntimeResolver = (
  configuredPath?: string,
) => Promise<QwenRuntimeDiagnostics>;

const PRESENTATION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  auth: "Configure Qwen authentication",
  clear: "Clear the current session",
  compress: "Compress conversation context",
  config: "Open Qwen configuration",
  context: "Show current context usage",
  diff: "Show the current change summary",
  doctor: "Check Qwen configuration and connectivity",
  extensions: "Manage Qwen extensions",
  help: "Show help for available commands",
  init: "Create or update workspace context",
  model: "Switch the active Qwen model",
  permissions: "Manage Qwen permissions",
  review: "Run the available review workflow",
  summary: "Summarize the current session",
  tools: "Show available Qwen tools",
};

export class QwenCommandProvider {
  private readonly cache = new Map<string, readonly SlashCommandSuggestion[]>();

  constructor(
    private readonly configuration: () => QwenClientConfiguration,
    private readonly logger: QwenCommandLogger,
    private readonly queryFactory: QwenCommandQueryFactory = query,
    private readonly runtimeResolver: QwenRuntimeResolver = inspectQwenRuntime,
  ) {}

  async discover(
    workspacePath: string,
    workspacePaths: readonly string[] = [],
  ): Promise<readonly SlashCommandSuggestion[]> {
    const cacheKey = `${workspacePath}\u0000${workspacePaths.join("\u0000")}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const runtime = await this.runtimeResolver(
        this.configuration().executablePath,
      );
      const launch = resolveCliLaunch(
        this.configuration().executablePath,
        runtime.cliExecutable,
      );
      const options: QueryOptions = {
        cwd: workspacePath,
        permissionMode: "default",
        logLevel: "error",
        ...(launch.executablePath === undefined
          ? {}
          : { pathToQwenExecutable: launch.executablePath }),
        ...(launch.targetPath === undefined
          ? {}
          : { env: { QWEN_FRONTEND_CLI_TARGET: launch.targetPath } }),
        ...(workspacePaths.length <= 1
          ? {}
          : { includeDirectories: [...workspacePaths.slice(1)] }),
      };
      const activeQuery = this.queryFactory({
        prompt: createIdlePrompt(),
        options,
      });
      let rawCommands: unknown = undefined;
      try {
        await activeQuery.initialized;
        rawCommands = await activeQuery.supportedCommands();
      } finally {
        await closeQuery(activeQuery, this.logger);
      }
      const customCommands = await discoverCustomCommands(workspacePath);
      const commands = normalizeCommands(rawCommands, customCommands);
      this.cache.set(cacheKey, commands);
      return commands;
    } catch (error) {
      this.logger.error("Qwen command discovery is unavailable.", error);
      return [];
    }
  }

  refresh(): void {
    this.cache.clear();
  }
}

interface CustomCommandMetadata {
  readonly source: "project" | "user";
  readonly description?: string;
}

async function closeQuery(
  queryInstance: Query,
  logger: QwenCommandLogger,
): Promise<void> {
  try {
    await queryInstance.close();
  } catch (error) {
    logger.debug(
      `Qwen command discovery query close reported: ${toErrorMessage(error)}`,
    );
  }
}

async function* createIdlePrompt(): AsyncIterable<never> {
  const noMessages: readonly never[] = [];
  yield* noMessages;
  await new Promise<void>(() => undefined);
}

function normalizeCommands(
  value: unknown,
  customCommands: ReadonlyMap<string, CustomCommandMetadata>,
): readonly SlashCommandSuggestion[] {
  const rawCommands = readCommandEntries(value);
  const commands = new Map<string, SlashCommandSuggestion>();
  for (const raw of rawCommands) {
    const normalizedName = normalizeCommandName(raw.name);
    if (normalizedName === undefined || commands.has(normalizedName)) {
      continue;
    }
    const custom = customCommands.get(normalizedName);
    const description =
      raw.description ??
      custom?.description ??
      PRESENTATION_DESCRIPTIONS[normalizedName];
    const aliases = raw.aliases
      ?.map(normalizeCommandName)
      .filter((alias): alias is string => alias !== undefined);
    commands.set(normalizedName, {
      name: `/${normalizedName}`,
      ...(description === undefined ? {} : { description }),
      source:
        custom?.source === "project"
          ? "Project command"
          : custom?.source === "user"
            ? "User command"
            : (raw.source ?? "Qwen runtime"),
      ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
      ...(raw.argumentHint === undefined
        ? {}
        : { argumentHint: raw.argumentHint }),
    });
  }
  return [...commands.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

interface RawCommandEntry {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly aliases?: readonly string[];
  readonly argumentHint?: string;
}

function readCommandEntries(value: unknown): readonly RawCommandEntry[] {
  if (!isRecord(value)) {
    return [];
  }
  const commands =
    value.commands ?? value.availableCommands ?? value.slash_commands;
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.flatMap((command): RawCommandEntry[] => {
    if (typeof command === "string") {
      return [{ name: command }];
    }
    if (!isRecord(command) || typeof command.name !== "string") {
      return [];
    }
    const metadata = isRecord(command._meta) ? command._meta : undefined;
    const input = isRecord(command.input) ? command.input : undefined;
    const aliases = readStringArray(
      command.aliases ?? metadata?.altNames ?? metadata?.aliases,
    );
    return [
      {
        name: command.name,
        ...(typeof command.description === "string"
          ? { description: command.description }
          : {}),
        ...(typeof metadata?.sourceLabel === "string"
          ? { source: metadata.sourceLabel }
          : typeof metadata?.source === "string"
            ? { source: metadata.source }
            : {}),
        ...(aliases.length === 0 ? {} : { aliases }),
        ...(typeof input?.hint === "string" && input.hint.length > 0
          ? { argumentHint: input.hint }
          : typeof metadata?.argumentHint === "string" &&
              metadata.argumentHint.length > 0
            ? { argumentHint: metadata.argumentHint }
            : {}),
      },
    ];
  });
}

async function discoverCustomCommands(
  workspacePath: string,
): Promise<ReadonlyMap<string, CustomCommandMetadata>> {
  const result = new Map<string, CustomCommandMetadata>();
  const userDirectory = join(
    process.env.QWEN_HOME ?? join(homedir(), ".qwen"),
    "commands",
  );
  const projectDirectory = join(workspacePath, ".qwen", "commands");
  await addCustomCommands(result, userDirectory, userDirectory, "user");
  await addCustomCommands(
    result,
    projectDirectory,
    projectDirectory,
    "project",
  );
  return result;
}

async function addCustomCommands(
  result: Map<string, CustomCommandMetadata>,
  rootDirectory: string,
  directory: string,
  source: "project" | "user",
): Promise<void> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await addCustomCommands(result, rootDirectory, path, source);
      continue;
    }
    if (!entry.isFile() || ![".md", ".toml"].includes(extname(entry.name))) {
      continue;
    }
    const commandName = normalizeCommandName(
      relative(rootDirectory, path)
        .replaceAll(sep, ":")
        .replace(/\.(?:md|toml)$/iu, ""),
    );
    if (commandName === undefined) {
      continue;
    }
    const description = await readCommandDescription(path);
    result.set(commandName, {
      source,
      ...(description === undefined ? {} : { description }),
    });
  }
}

async function readCommandDescription(
  path: string,
): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
    const source = frontmatter ?? content.slice(0, 2_000);
    const match =
      /^(?:\s*description\s*[:=]\s*)(?:["']([^"']+)["']|([^\r\n#]+))/imu.exec(
        source,
      );
    return match?.[1]?.trim() ?? match?.[2]?.trim();
  } catch {
    return undefined;
  }
}

function normalizeCommandName(value: string): string | undefined {
  const normalized = value.trim().replace(/^\/+/, "");
  return normalized.length === 0 ? undefined : normalized;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
