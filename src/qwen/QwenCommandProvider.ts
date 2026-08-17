import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { query, type Query, type QueryOptions } from "@qwen-code/sdk";
import type {
  SlashCommandDescriptor,
  SlashCommandOrigin,
} from "../commands/SlashCommand.js";
import type { QwenClientConfiguration } from "./QwenCodeAgentClient.js";
import { resolveCliLaunch } from "./QwenCodeAgentClient.js";
import {
  inspectQwenRuntime,
  type QwenRuntimeDiagnostics,
} from "./QwenRuntimeDiagnostics.js";

export interface QwenCommandLogger {
  debug(message: string): void;
  error(message: string, error?: unknown): void;
}

export type QwenCommandQueryFactory = typeof query;
export type QwenRuntimeResolver = (
  configuredPath?: string,
) => Promise<QwenRuntimeDiagnostics>;

/** Discovers the command surface reported by the active Qwen runtime. */
export class QwenCommandProvider {
  private readonly cache = new Map<string, readonly SlashCommandDescriptor[]>();

  constructor(
    private readonly configuration: () => QwenClientConfiguration,
    private readonly logger: QwenCommandLogger,
    private readonly queryFactory: QwenCommandQueryFactory = query,
    private readonly runtimeResolver: QwenRuntimeResolver = inspectQwenRuntime,
  ) {}

  async discover(
    workspacePath: string,
    workspacePaths: readonly string[] = [],
  ): Promise<readonly SlashCommandDescriptor[]> {
    const cacheKey = `${workspacePath}\u0000${workspacePaths.join("\u0000")}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

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
      let rawCommands: unknown;
      try {
        await activeQuery.initialized;
        rawCommands = await activeQuery.supportedCommands();
      } finally {
        await closeQuery(activeQuery, this.logger);
      }
      const commands = normalizeCommands(
        rawCommands,
        await discoverCustomCommands(workspacePath),
      );
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
  readonly usage?: string;
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
): readonly SlashCommandDescriptor[] {
  const commands = new Map<string, SlashCommandDescriptor>();
  for (const raw of readCommandEntries(value)) {
    const name = normalizeCommandName(raw.name);
    if (name === undefined || commands.has(name)) continue;
    const custom = customCommands.get(name);
    const aliases = raw.aliases
      ?.map(normalizeCommandName)
      .filter((alias): alias is string => alias !== undefined)
      .map((alias) => `/${alias}`);
    const usage = raw.usage ?? custom?.usage;
    const command = `/${name}`;
    commands.set(name, {
      id: `qwen:${name}`,
      command,
      title: command,
      description:
        raw.description ??
        custom?.description ??
        "Command reported by the active Qwen runtime.",
      ...(usage === undefined ? {} : { usage }),
      ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
      source: "qwen",
      origin: normalizeOrigin(custom?.source ?? raw.source ?? "qwen"),
      executionMode: "qwen-sdk",
      available: true,
    });
  }

  for (const [rawName, custom] of customCommands) {
    const name = normalizeCommandName(rawName);
    if (name === undefined || commands.has(name)) continue;
    const command = `/${name}`;
    commands.set(name, {
      id: `qwen:${name}`,
      command,
      title: command,
      description:
        custom.description ??
        "Custom command discovered in Qwen configuration.",
      ...(custom.usage === undefined ? {} : { usage: custom.usage }),
      source: "qwen",
      origin: custom.source,
      executionMode: "qwen-sdk",
      available: true,
    });
  }

  return [...commands.values()].sort((left, right) =>
    left.command.localeCompare(right.command),
  );
}

interface RawCommandEntry {
  readonly name: string;
  readonly description?: string;
  readonly source?: unknown;
  readonly aliases?: readonly string[];
  readonly usage?: string;
}

function readCommandEntries(value: unknown): readonly RawCommandEntry[] {
  if (!isRecord(value)) return [];
  const commands =
    value.commands ?? value.availableCommands ?? value.slash_commands;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((entry): RawCommandEntry[] => {
    if (typeof entry === "string") return [{ name: entry }];
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    const metadata = isRecord(entry._meta) ? entry._meta : undefined;
    const input = isRecord(entry.input) ? entry.input : undefined;
    const normalizedName = normalizeCommandName(entry.name) ?? entry.name;
    const aliases = readStringArray(
      entry.aliases ??
        entry.altNames ??
        metadata?.altNames ??
        metadata?.aliases,
    );
    const description = firstString(
      entry.description,
      entry.help,
      metadata?.description,
    );
    const source = firstString(
      entry.sourceLabel,
      entry.source,
      metadata?.sourceLabel,
      metadata?.source,
    );
    const hint = firstString(
      entry.argumentHint,
      input?.hint,
      metadata?.argumentHint,
    );
    const usage =
      firstString(entry.usage) ??
      (hint === undefined ? undefined : `/${normalizedName} ${hint}`);
    return [
      {
        name: entry.name,
        ...(description === undefined ? {} : { description }),
        ...(source === undefined ? {} : { source }),
        ...(aliases.length === 0 ? {} : { aliases }),
        ...(usage === undefined ? {} : { usage }),
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
    if (!entry.isFile() || ![".md", ".toml"].includes(extname(entry.name)))
      continue;
    const name = normalizeCommandName(
      relative(rootDirectory, path)
        .replaceAll(sep, ":")
        .replace(/\.(?:md|toml)$/iu, ""),
    );
    if (name === undefined) continue;
    const metadata = await readCustomCommandMetadata(path);
    result.set(name, {
      source,
      ...(metadata.description === undefined
        ? {}
        : { description: metadata.description }),
      ...(metadata.usage === undefined
        ? {}
        : { usage: `/${name} ${metadata.usage}` }),
    });
  }
}

async function readCustomCommandMetadata(path: string): Promise<{
  readonly description?: string;
  readonly usage?: string;
}> {
  try {
    const content = await readFile(path, "utf8");
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
    const source = frontmatter ?? content.slice(0, 2_000);
    const description = readFrontmatterValue(source, "description");
    const usage = readFrontmatterValue(
      source,
      "argument-hint|argumentHint|usage",
    );
    return {
      ...(description === undefined ? {} : { description }),
      ...(usage === undefined ? {} : { usage }),
    };
  } catch {
    return {};
  }
}

function normalizeCommandName(value: string): string | undefined {
  const normalized = value.trim().replace(/^\/+/, "").toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeOrigin(value: unknown): SlashCommandOrigin {
  if (typeof value !== "string") return "unknown";
  const source = value.toLowerCase().replaceAll("_", "-");
  if (source.includes("project")) return "project";
  if (source.includes("user")) return "user";
  if (source.includes("skill")) return "skill";
  if (source.includes("mcp")) return "mcp";
  if (source.includes("extension")) return "extension";
  if (source.includes("builtin") || source.includes("built-in"))
    return "builtin";
  if (source.includes("qwen") || source === "runtime") return "qwen";
  return "unknown";
}

function readFrontmatterValue(source: string, key: string): string | undefined {
  const match = new RegExp(
    `^\\s*(?:${key})\\s*[:=]\\s*(?:["']([^"']+)["']|([^\\r\\n#]+))`,
    "imu",
  ).exec(source);
  return match?.[1]?.trim() ?? match?.[2]?.trim();
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
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
