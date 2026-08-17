import { execFile } from "node:child_process";
import {
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { TimelineItem } from "../webview/messages.js";
import type { QwenClientConfiguration } from "./QwenCodeAgentClient.js";
import { resolveCliLaunch } from "./QwenCodeAgentClient.js";
import {
  inspectQwenRuntime,
  type QwenRuntimeDiagnostics,
} from "./QwenRuntimeDiagnostics.js";
import { QwenTranscriptLoader } from "./QwenTranscriptLoader.js";

const execFileAsync = promisify(execFile);
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SESSION_LIST_LIMIT = "1000";

export interface QwenSavedSession {
  readonly sessionId: string;
  readonly title: string;
  readonly initialPrompt?: string;
  readonly cwd: string;
  readonly gitBranch?: string;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly isCurrent: boolean;
  readonly transcriptPath: string;
}

export interface QwenSessionHistoryLogger {
  debug(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface QwenSessionListEntry {
  readonly sessionId: string;
  readonly startTime?: string;
  readonly mtime: number;
  readonly prompt?: string;
  readonly gitBranch?: string;
  readonly customTitle?: string;
  readonly titleSource?: string;
  readonly filePath: string;
  readonly cwd: string;
}

export interface QwenCliExecutionOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type QwenCliExecutor = (
  command: string,
  args: readonly string[],
  options: QwenCliExecutionOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type QwenRuntimeHistoryResolver = (
  configuredPath?: string,
) => Promise<QwenRuntimeDiagnostics>;

export interface DeleteSessionsResult {
  readonly removed: readonly string[];
  readonly errors: readonly {
    readonly sessionId: string;
    readonly error: string;
  }[];
}

export class QwenSessionHistoryService {
  private readonly transcriptLoader: QwenTranscriptLoader;

  constructor(
    private readonly configuration: () => QwenClientConfiguration,
    private readonly logger: QwenSessionHistoryLogger,
    private readonly runtimeResolver: QwenRuntimeHistoryResolver = inspectQwenRuntime,
    private readonly cliExecutor: QwenCliExecutor = executeQwenCli,
    transcriptLoader = new QwenTranscriptLoader(),
  ) {
    this.transcriptLoader = transcriptLoader;
  }

  async list(
    workspacePaths: readonly string[],
    currentSessionId?: string,
  ): Promise<readonly QwenSavedSession[]> {
    if (workspacePaths.length === 0) {
      return [];
    }
    const runtime = await this.runtimeResolver(
      this.configuration().executablePath,
    );
    const executions = await Promise.all(
      workspacePaths.map(async (workspacePath) => {
        try {
          return await this.executeSessionsList(runtime, workspacePath);
        } catch (error) {
          this.logger.error(
            `Unable to list Qwen sessions for ${workspacePath}.`,
            error,
          );
          return undefined;
        }
      }),
    );
    if (executions.every((execution) => execution === undefined)) {
      throw new Error(
        "Unable to list Qwen chat history from the configured runtime.",
      );
    }
    const entries = executions.flatMap((execution) =>
      execution === undefined
        ? []
        : parseSessionListJsonLines(execution.stdout),
    );
    const roots = await Promise.all(workspacePaths.map(canonicalWorkspacePath));
    const entriesWithCanonicalCwd = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        canonicalCwd: await canonicalWorkspacePath(entry.cwd),
      })),
    );
    const sessions = entriesWithCanonicalCwd
      .filter(({ canonicalCwd }) => roots.includes(canonicalCwd))
      .map(({ entry }) => normalizeSavedSession(entry, currentSessionId))
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          (right.startedAt ?? 0) - (left.startedAt ?? 0),
      );
    const uniqueSessions = deduplicateSessions(sessions);
    this.logger.debug(
      `Session history refreshed: workspaceCount=${String(roots.length)} count=${String(uniqueSessions.length)}.`,
    );
    return uniqueSessions;
  }

  async loadTranscript(
    session: QwenSavedSession,
  ): Promise<readonly TimelineItem[]> {
    return this.transcriptLoader.load(
      session.transcriptPath,
      session.sessionId,
    );
  }

  async delete(session: QwenSavedSession): Promise<void> {
    const paths = getQwenSessionPaths(
      session.transcriptPath,
      session.sessionId,
    );
    const activeExists = await exists(paths.activeTranscript);
    const archivedExists = await exists(paths.archivedTranscript);
    if (!activeExists && !archivedExists) {
      throw new Error(`Qwen session ${session.sessionId} was not found.`);
    }
    await verifyTranscriptOwnership(
      activeExists ? paths.activeTranscript : paths.archivedTranscript,
      session,
    );

    await removeIfPresent(paths.activeTranscript);
    await removeIfPresent(paths.archivedTranscript);
    await removeIfPresent(paths.activeWorktreeSidecar);
    await removeIfPresent(paths.archivedWorktreeSidecar);

    // This mirrors the installed Qwen 0.19.10 SessionService.removeSessionFiles
    // implementation. The session list has already verified project ownership;
    // these paths are derived from its exact UUID-named transcript location.
    const fileHistoryRoot = join(
      process.env.QWEN_HOME ?? join(homedir(), ".qwen"),
      "file-history",
      session.sessionId,
    );
    await rm(fileHistoryRoot, { recursive: true, force: true });
    await removeSessionOrganization(paths.projectDirectory, session.sessionId);
    this.logger.debug(`Qwen session deleted: sessionId=${session.sessionId}.`);
  }

  async deleteInactive(
    workspacePaths: readonly string[],
    currentSessionId?: string,
  ): Promise<DeleteSessionsResult> {
    const sessions = await this.list(workspacePaths, currentSessionId);
    const removed: string[] = [];
    const errors: { sessionId: string; error: string }[] = [];
    for (const session of sessions) {
      if (session.isCurrent) {
        continue;
      }
      try {
        await this.delete(session);
        removed.push(session.sessionId);
      } catch (error) {
        errors.push({
          sessionId: session.sessionId,
          error: toErrorMessage(error),
        });
      }
    }
    return { removed, errors };
  }

  private async executeSessionsList(
    runtime: QwenRuntimeDiagnostics,
    workspacePath: string,
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    const launch = resolveCliLaunch(
      this.configuration().executablePath,
      runtime.cliExecutable,
    );
    const executable = launch.executablePath ?? runtime.cliExecutable;
    const extension = executable
      .slice(executable.lastIndexOf("."))
      .toLowerCase();
    const isJavaScript = [".js", ".mjs", ".cjs"].includes(extension);
    const isBatch = [".cmd", ".bat"].includes(extension);
    const command = isJavaScript
      ? process.execPath
      : isBatch
        ? (process.env.ComSpec ?? "cmd.exe")
        : executable;
    const args = isJavaScript
      ? [
          executable,
          "sessions",
          "list",
          "--json",
          "--limit",
          SESSION_LIST_LIMIT,
        ]
      : isBatch
        ? [
            "/d",
            "/s",
            "/c",
            `call "${executable}" sessions list --json --limit ${SESSION_LIST_LIMIT}`,
          ]
        : ["sessions", "list", "--json", "--limit", SESSION_LIST_LIMIT];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (launch.targetPath !== undefined) {
      env.QWEN_FRONTEND_CLI_TARGET = launch.targetPath;
    }
    return this.cliExecutor(command, args, { cwd: workspacePath, env });
  }
}

export function parseSessionListJsonLines(
  value: string,
): readonly QwenSessionListEntry[] {
  const entries: QwenSessionListEntry[] = [];
  for (const line of value.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      const entry = parseSessionListEntry(parsed);
      if (entry !== undefined) {
        entries.push(entry);
      }
    } catch {
      // JSONL may contain a truncated final record while Qwen is writing it.
    }
  }
  return entries;
}

export function normalizeWorkspacePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = pathApi.normalize(value.replaceAll("\\", pathApi.sep));
  const absolute = pathApi.resolve(normalized);
  const withoutTrailingSeparator = absolute.replace(/[\\/]$/u, "");
  return platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

export function chooseSessionTitle(
  entry: Pick<QwenSessionListEntry, "sessionId" | "prompt" | "customTitle">,
): string {
  const customTitle = entry.customTitle?.trim();
  if (customTitle !== undefined && customTitle.length > 0) {
    return customTitle;
  }
  const prompt = entry.prompt?.replace(/\s+/gu, " ").trim();
  if (prompt !== undefined && prompt.length > 0) {
    return prompt.length <= 90 ? prompt : `${prompt.slice(0, 87)}…`;
  }
  return entry.sessionId.slice(0, 8);
}

function parseSessionListEntry(
  value: unknown,
): QwenSessionListEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(entry.sessionId) ||
    typeof entry.filePath !== "string" ||
    typeof entry.cwd !== "string" ||
    typeof entry.mtime !== "number" ||
    !Number.isFinite(entry.mtime)
  ) {
    return undefined;
  }
  return {
    sessionId: entry.sessionId,
    mtime: entry.mtime,
    filePath: entry.filePath,
    cwd: entry.cwd,
    ...(typeof entry.startTime === "string"
      ? { startTime: entry.startTime }
      : {}),
    ...(typeof entry.prompt === "string" ? { prompt: entry.prompt } : {}),
    ...(typeof entry.gitBranch === "string"
      ? { gitBranch: entry.gitBranch }
      : {}),
    ...(typeof entry.customTitle === "string"
      ? { customTitle: entry.customTitle }
      : {}),
    ...(typeof entry.titleSource === "string"
      ? { titleSource: entry.titleSource }
      : {}),
  };
}

function normalizeSavedSession(
  entry: QwenSessionListEntry,
  currentSessionId: string | undefined,
): QwenSavedSession {
  const startedAt =
    entry.startTime === undefined ? undefined : Date.parse(entry.startTime);
  return {
    sessionId: entry.sessionId,
    title: chooseSessionTitle(entry),
    ...(entry.prompt === undefined ? {} : { initialPrompt: entry.prompt }),
    cwd: entry.cwd,
    ...(entry.gitBranch === undefined ? {} : { gitBranch: entry.gitBranch }),
    ...(startedAt === undefined || Number.isNaN(startedAt)
      ? {}
      : { startedAt }),
    updatedAt: entry.mtime,
    isCurrent: entry.sessionId === currentSessionId,
    transcriptPath: entry.filePath,
  };
}

function deduplicateSessions(
  sessions: readonly QwenSavedSession[],
): readonly QwenSavedSession[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.sessionId)) {
      return false;
    }
    seen.add(session.sessionId);
    return true;
  });
}

export async function canonicalWorkspacePath(value: string): Promise<string> {
  try {
    return normalizeWorkspacePath(await realpath(value));
  } catch {
    return normalizeWorkspacePath(value);
  }
}

async function verifyTranscriptOwnership(
  transcriptPath: string,
  session: QwenSavedSession,
): Promise<void> {
  const source = await readFile(transcriptPath, "utf8");
  const firstLine = source
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    throw new Error("Qwen returned an empty transcript; it was not deleted.");
  }
  let firstRecord: unknown;
  try {
    firstRecord = JSON.parse(firstLine);
  } catch (error) {
    throw new Error(
      "Qwen returned an invalid transcript; it was not deleted.",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(firstRecord) || firstRecord.sessionId !== session.sessionId) {
    throw new Error(
      "The Qwen transcript does not belong to the selected session; it was not deleted.",
    );
  }
  if (
    typeof firstRecord.cwd === "string" &&
    normalizeWorkspacePath(firstRecord.cwd) !==
      normalizeWorkspacePath(session.cwd)
  ) {
    throw new Error(
      "The Qwen transcript belongs to a different workspace; it was not deleted.",
    );
  }
}

interface QwenSessionPaths {
  readonly projectDirectory: string;
  readonly activeTranscript: string;
  readonly archivedTranscript: string;
  readonly activeWorktreeSidecar: string;
  readonly archivedWorktreeSidecar: string;
}

function getQwenSessionPaths(
  transcriptPath: string,
  sessionId: string,
): QwenSessionPaths {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Qwen returned an invalid session ID.");
  }
  const normalizedPath = resolve(transcriptPath);
  if (basename(normalizedPath) !== `${sessionId}.jsonl`) {
    throw new Error(
      "Qwen returned a transcript path that does not match its session ID.",
    );
  }
  const parent = dirname(normalizedPath);
  const chatsDirectory =
    basename(parent) === "chats" ? parent : dirname(parent);
  if (
    basename(chatsDirectory) !== "chats" ||
    basename(dirname(chatsDirectory)) === ""
  ) {
    throw new Error("Qwen returned an unsafe transcript location.");
  }
  const projectDirectory = dirname(chatsDirectory);
  return {
    projectDirectory,
    activeTranscript: join(chatsDirectory, `${sessionId}.jsonl`),
    archivedTranscript: join(chatsDirectory, "archive", `${sessionId}.jsonl`),
    activeWorktreeSidecar: join(chatsDirectory, `${sessionId}.worktree.json`),
    archivedWorktreeSidecar: join(
      chatsDirectory,
      "archive",
      `${sessionId}.worktree.json`,
    ),
  };
}

async function removeSessionOrganization(
  projectDirectory: string,
  sessionId: string,
): Promise<void> {
  const path = join(projectDirectory, "session-organization.v1.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return;
    }
    const store = parsed as Record<string, unknown>;
    const sessions = store.sessions;
    if (
      typeof sessions !== "object" ||
      sessions === null ||
      Array.isArray(sessions)
    ) {
      return;
    }
    if (!(sessionId in sessions)) {
      return;
    }
    store.sessions = Object.fromEntries(
      Object.entries(sessions).filter(([key]) => key !== sessionId),
    );
    await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return;
    }
    throw error;
  }
}

async function executeQwenCli(
  command: string,
  args: readonly string[],
  options: QwenCliExecutionOptions,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
    ...(command.toLowerCase().endsWith(".cmd")
      ? { windowsVerbatimArguments: true }
      : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
