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
import type {
  SlashCommandSource,
  SlashCommandSuggestion,
} from "../webview/messages.js";

export interface QwenCommandLogger {
  debug(message: string): void;
  error(message: string, error?: unknown): void;
}

export type QwenCommandQueryFactory = typeof query;
export type QwenRuntimeResolver = (
  configuredPath?: string,
) => Promise<QwenRuntimeDiagnostics>;

interface FallbackCommandMetadata {
  readonly description: string;
  readonly usage?: string;
  readonly aliases?: readonly string[];
}

// The SDK 0.1.8 query control endpoint returns names only. These values are
// deliberately kept as a fallback: runtime metadata and custom command
// declarations always win, and unknown commands remain description-less.
const BUILTIN_DESCRIPTION_FALLBACKS: Readonly<
  Record<string, FallbackCommandMetadata>
> = {
  "approval-mode": {
    description: "View or change the approval mode for tool usage",
    usage: "/approval-mode <mode>",
  },
  agents: { description: "Manage subagents for specialized task delegation." },
  arena: { description: "Manage Arena sessions" },
  auth: {
    description: "Connect an LLM provider",
    aliases: ["connect", "login"],
  },
  branch: { description: "Fork the current conversation into a new session" },
  bug: { description: "Submit a bug report" },
  clear: { description: "Clear the current session" },
  compress: {
    description: "Compresses the context by replacing it with a summary.",
    aliases: ["summarize"],
  },
  context: {
    description: "Show context window usage breakdown",
    usage: "/context [detail]",
  },
  "compress-fast": {
    description:
      "Fast context compression without AI. Strips old tool outputs and thinking parts.",
  },
  config: {
    description: "Get or set any Qwen Code setting by dot-path key",
    usage: "/config <key>[=<value>] or --help",
  },
  delete: { description: "Delete a previous session" },
  diff: { description: "Show working-tree change stats versus HEAD" },
  directory: {
    description: "Manage workspace directories",
    aliases: ["dir"],
    usage: "/directory <path>[,<path>,...]",
  },
  docs: { description: "Open full Qwen Code documentation in your browser" },
  doctor: { description: "Run installation and environment diagnostics" },
  editor: { description: "Set external editor preference" },
  effort: {
    description:
      "Set how hard reasoning-capable models think (low, medium, high, xhigh, max); mapped and clamped per provider.",
    usage: "/effort [low|medium|high|xhigh|max]",
  },
  export: {
    description: "Export current session message history to a file",
    usage: "/export [md|html|json|jsonl] [path]",
  },
  extensions: { description: "Manage installed extensions" },
  fork: {
    description: "Spawn a background agent that inherits the full conversation",
    usage: "/fork <directive>",
  },
  goal: {
    description: "Set a goal — keep working until the condition is met",
    usage: "/goal [<condition> | clear]",
  },
  history: {
    description: "Control history display preferences and visibility",
    usage: "/history collapse-on-resume|expand-on-resume|expand-now",
  },
  help: { description: "Get help on Qwen Code", aliases: ["?"] },
  init: {
    description: "Analyze the project and create a tailored QWEN.md file",
  },
  "import-config": {
    description: "Import MCP servers from Claude configs",
    usage:
      "/import-config [all|claude-code|claude-desktop] [--scope user|project]",
  },
  language: {
    description: "View or change the language setting",
    usage: "/language ui|output <language>",
  },
  model: {
    description:
      "Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion).",
    usage:
      "/model [--fast|--voice|--vision] [--project|--global] [<model-id>] | <model-id> <prompt>",
  },
  insight: {
    description:
      "Generate personalized programming insights from your chat history",
  },
  mcp: { description: "Open MCP management dialog" },
  memory: { description: "Open the memory manager" },
  plan: { description: "Switch to plan mode or exit plan mode" },
  permissions: { description: "Manage permission rules" },
  recap: { description: "Generate a one-line session recap now" },
  rename: {
    description: "Rename the current conversation",
    aliases: ["tag"],
    usage: "/rename [--auto] [<name>]",
  },
  rewind: {
    description: "Rewind conversation to a previous turn",
    aliases: ["rollback"],
  },
  resume: {
    description: "Resume a previous session",
    aliases: ["continue"],
    usage: "/resume [session-id]",
  },
  tasks: {
    description:
      "List background tasks (text dump — interactive dialog opens via the footer pill)",
    usage: "/tasks",
  },
  settings: { description: "View and edit Qwen Code settings" },
  summary: {
    description:
      "Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md",
  },
  skills: {
    description: "Open the skills panel (browse, search, toggle, pick).",
  },
  stats: {
    description: "Show usage statistics dashboard.",
    aliases: ["usage"],
    usage: "/stats [model|tools|skills|daily|monthly|export]",
  },
  status: { description: "Show version info", aliases: ["about"] },
  tools: {
    description: "List available Qwen Code tools.",
    usage: "/tools [desc]",
  },
  trust: { description: "Manage folder trust settings" },
  update: {
    description: "Check for Qwen Code updates and install if available",
  },
  vim: { description: "Toggle vim mode on/off" },
  voice: { description: "Toggle voice dictation input" },
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
): readonly SlashCommandSuggestion[] {
  const rawCommands = readCommandEntries(value);
  const commands = new Map<string, SlashCommandSuggestion>();
  for (const raw of rawCommands) {
    const normalizedName = normalizeCommandName(raw.name);
    if (normalizedName === undefined || commands.has(normalizedName)) {
      continue;
    }
    const custom = customCommands.get(normalizedName);
    const fallback = BUILTIN_DESCRIPTION_FALLBACKS[normalizedName];
    const description =
      raw.description ?? custom?.description ?? fallback?.description;
    const aliases =
      raw.aliases
        ?.map(normalizeCommandName)
        .filter((alias): alias is string => alias !== undefined) ??
      fallback?.aliases;
    const usage = raw.usage ?? custom?.usage ?? fallback?.usage;
    commands.set(normalizedName, {
      name: `/${normalizedName}`,
      ...(description === undefined ? {} : { description }),
      source: normalizeSource(
        custom?.source === "project"
          ? "project"
          : custom?.source === "user"
            ? "user"
            : (raw.source ?? (fallback === undefined ? "qwen" : "builtin")),
      ),
      available: true,
      ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
      ...(usage === undefined ? {} : { usage }),
    });
  }
  for (const [name, custom] of customCommands) {
    const normalizedName = normalizeCommandName(name);
    if (normalizedName === undefined || commands.has(normalizedName)) {
      continue;
    }
    commands.set(normalizedName, {
      name: `/${normalizedName}`,
      ...(custom.description === undefined
        ? {}
        : { description: custom.description }),
      ...(custom.usage === undefined ? {} : { usage: custom.usage }),
      source: custom.source,
      available: true,
    });
  }
  return [...commands.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
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
      command.aliases ??
        command.altNames ??
        metadata?.altNames ??
        metadata?.aliases,
    );
    const description =
      typeof command.description === "string"
        ? command.description
        : typeof command.help === "string"
          ? command.help
          : typeof metadata?.description === "string"
            ? metadata.description
            : undefined;
    const source =
      typeof command.sourceLabel === "string"
        ? command.sourceLabel
        : typeof command.source === "string"
          ? command.source
          : typeof metadata?.sourceLabel === "string"
            ? metadata.sourceLabel
            : typeof metadata?.source === "string"
              ? metadata.source
              : undefined;
    const normalizedName = normalizeCommandName(command.name) ?? command.name;
    const usage =
      typeof command.usage === "string" && command.usage.length > 0
        ? command.usage
        : typeof command.argumentHint === "string" &&
            command.argumentHint.length > 0
          ? `/${normalizedName} ${command.argumentHint}`
          : typeof input?.hint === "string" && input.hint.length > 0
            ? `/${normalizedName} ${input.hint}`
            : typeof metadata?.argumentHint === "string" &&
                metadata.argumentHint.length > 0
              ? `/${normalizedName} ${metadata.argumentHint}`
              : undefined;
    return [
      {
        name: command.name,
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
    const metadata = await readCustomCommandMetadata(path);
    result.set(commandName, {
      source,
      ...(metadata.description === undefined
        ? {}
        : { description: metadata.description }),
      ...(metadata.usage === undefined
        ? {}
        : { usage: `/${commandName} ${metadata.usage}` }),
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
    const usage = readCommandUsage(source);
    return {
      ...(description === undefined ? {} : { description }),
      ...(usage === undefined ? {} : { usage }),
    };
  } catch {
    return {};
  }
}

function normalizeCommandName(value: string): string | undefined {
  const normalized = value.trim().replace(/^\/+/, "");
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeSource(value: unknown): SlashCommandSource {
  if (typeof value !== "string") {
    return "unknown";
  }
  const source = value.toLowerCase().replaceAll("_", "-");
  if (source.includes("project")) return "project";
  if (source.includes("user")) return "user";
  if (source.includes("skill")) return "skill";
  if (source.includes("mcp")) return "mcp";
  if (source.includes("extension")) return "extension";
  if (source.includes("builtin") || source.includes("built-in")) {
    return "builtin";
  }
  if (source.includes("qwen") || source === "runtime") return "qwen";
  return "unknown";
}

function readCommandUsage(content: string): string | undefined {
  return readFrontmatterValue(content, "argument-hint|argumentHint|usage");
}

function readFrontmatterValue(source: string, key: string): string | undefined {
  const match = new RegExp(
    `^\\s*(?:${key})\\s*[:=]\\s*(?:["']([^"']+)["']|([^\\r\\n#]+))`,
    "imu",
  ).exec(source);
  return match?.[1]?.trim() ?? match?.[2]?.trim();
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
