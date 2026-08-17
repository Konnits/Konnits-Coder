import { access } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isAbortError,
  query,
  type Query,
  type QueryOptions,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Usage,
  type ToolInput,
} from "@qwen-code/sdk";
import type {
  AgentClient,
  AgentSessionRestoreRequest,
  AgentSessionRestoreResult,
  AgentRunRequest,
  Disposable,
} from "../agent/AgentClient.js";
import type { AgentEvent } from "../agent/AgentEvent.js";
import { getEditTarget } from "../changes/toolTargets.js";
import type { PermissionManager } from "../permissions/PermissionManager.js";
import { classifyToolRisk } from "../permissions/toolRisk.js";
import { describeTool, QwenEventAdapter } from "./QwenEventAdapter.js";
import {
  actionableQwenError,
  QwenDiagnosticCapture,
} from "./QwenDiagnostics.js";
import {
  formatQwenRuntimeDiagnostics,
  inspectQwenRuntime,
  type QwenRuntimeDiagnostics,
} from "./QwenRuntimeDiagnostics.js";
import {
  formatQwenSubagentDiagnostics,
  resolveQwenSubagents,
  type QwenSubagentResolution,
} from "./QwenSubagentRegistry.js";
import {
  adaptQwenContextUsage,
  adaptQwenTurnUsage,
  aggregateQwenCallUsages,
} from "./QwenTokenUsageAdapter.js";
import type { TurnTokenUsage } from "../agent/TokenUsage.js";
import { ContextUsageRefreshScheduler } from "./ContextUsageRefreshScheduler.js";

export interface QwenClientConfiguration {
  readonly executablePath?: string;
  readonly debug: boolean;
  readonly allowImageInput?: boolean;
  /** Milliseconds without an SDK message before failing the turn. Zero disables it. */
  readonly streamIdleTimeoutMs?: number;
}

export interface QwenClientLogger {
  debug(message: string): void;
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface QwenChangeTracker {
  beforeEdit(target: string): Promise<void>;
  afterEdit(target: string): Promise<void>;
  completeAll(): Promise<void>;
}

export type QwenQueryFactory = typeof query;
export type QwenSubagentResolver = (
  runtime: QwenRuntimeDiagnostics,
  workspacePath: string,
) => Promise<QwenSubagentResolution>;
export type QwenRuntimeCleanupWait = () => Promise<void>;

const CLI_TARGET_ENVIRONMENT_VARIABLE = "QWEN_FRONTEND_CLI_TARGET";
export const DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS = 120_000;
const IMAGE_FILE_PATH =
  /\.(?:apng|avif|bmp|gif|heic|jpeg|jpg|png|svg|tif|tiff|webp)(?:[?#].*)?$/iu;

export class QwenCodeAgentClient implements AgentClient {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private activeTurn: ActiveQwenTurn | undefined;
  private runtimeDiagnostics: QwenRuntimeDiagnostics | undefined;

  constructor(
    private readonly configuration: () => QwenClientConfiguration,
    private readonly permissions: PermissionManager,
    private readonly changes: QwenChangeTracker,
    private readonly logger: QwenClientLogger,
    private readonly queryFactory: QwenQueryFactory = query,
    private readonly subagentResolver: QwenSubagentResolver = resolveQwenSubagents,
    private readonly runtimeCleanupWait: QwenRuntimeCleanupWait = waitForRuntimeCleanup,
  ) {}

  private readonly subagentResolutions = new Map<
    string,
    QwenSubagentResolution
  >();

  async connect(): Promise<void> {
    const executablePath = this.configuration().executablePath;
    if (executablePath !== undefined && isAbsolute(executablePath)) {
      try {
        await access(executablePath);
      } catch (error) {
        throw new Error(
          `Qwen Code executable is unavailable at ${executablePath}.`,
          {
            cause: error,
          },
        );
      }
    }
    this.runtimeDiagnostics = await inspectQwenRuntime(executablePath);
    for (const line of formatQwenRuntimeDiagnostics(this.runtimeDiagnostics)) {
      this.logger.info(line);
    }
    this.logger.info("Qwen SDK is ready.");
  }

  async run(request: AgentRunRequest): Promise<void> {
    if (this.activeTurn !== undefined) {
      throw new Error("A Qwen operation is already running.");
    }

    const runId = randomUUID();
    const abortController = new AbortController();
    const turn: ActiveQwenTurn = {
      runId,
      sessionId: request.sessionId,
      abortController,
      query: undefined,
      cancellationRequested: false,
    };
    const diagnostics = new QwenDiagnosticCapture(
      this.runtimeDiagnostics?.secrets ?? [],
    );
    this.activeTurn = turn;
    this.logger.debug(
      `Turn started: turnId=${runId} sessionId=${request.sessionId}.`,
    );
    this.emit({
      type: "agent.started",
      runId,
      sessionId: request.sessionId,
      timestamp: Date.now(),
    });

    try {
      this.logger.info("Qwen execution starting.");
      if (this.runtimeDiagnostics !== undefined) {
        for (const line of formatQwenRuntimeDiagnostics(
          this.runtimeDiagnostics,
          request.workspacePath,
        )) {
          this.logger.info(line);
        }
      }
      this.logger.debug(`Prompt length: ${String(request.prompt.length)}`);
      let executionResult: QwenExecutionResult;
      try {
        executionResult = await this.executeQuery(
          request,
          runId,
          turn,
          request.resume,
          diagnostics,
        );
      } catch (error) {
        if (
          request.resume &&
          !turn.cancellationRequested &&
          !abortController.signal.aborted &&
          diagnostics.containsMissingSession()
        ) {
          this.logger.info(
            "The persisted Qwen session does not exist; retrying once as a new session.",
          );
          await this.closeActiveQuery(turn);
          diagnostics.clear();
          executionResult = await this.executeQuery(
            request,
            runId,
            turn,
            false,
            diagnostics,
          );
        } else if (
          !turn.cancellationRequested &&
          !abortController.signal.aborted &&
          isExtensionStoreBusy(error, diagnostics)
        ) {
          this.logger.info(
            "The Qwen extension store is still closing; retrying once.",
          );
          await this.closeActiveQuery(turn);
          diagnostics.clear();
          await this.runtimeCleanupWait();
          executionResult = await this.executeQuery(
            request,
            runId,
            turn,
            request.resume,
            diagnostics,
          );
        } else {
          throw error;
        }
      }

      if (turn.cancellationRequested) {
        throw new Error("Qwen turn cancelled by the user.");
      }
      await this.changes.completeAll();
      this.emit({
        type: "agent.completed",
        runId,
        ...(executionResult.text === undefined
          ? {}
          : { result: executionResult.text }),
        ...(executionResult.turnUsage === undefined
          ? {}
          : { turnUsage: executionResult.turnUsage }),
        timestamp: Date.now(),
      });
    } catch (error) {
      await this.safelyCompleteTrackedChanges();
      if (
        turn.cancellationRequested ||
        isAbortError(error) ||
        abortController.signal.aborted
      ) {
        this.logger.debug(`Turn cancelled: turnId=${runId}.`);
        this.emit({ type: "agent.cancelled", runId, timestamp: Date.now() });
      } else {
        const message = toErrorMessage(error);
        const diagnostic = diagnostics.summary();
        this.logger.error("Qwen operation failed.", error);
        if (diagnostic !== undefined) {
          this.logger.error(`Qwen diagnostic:\n${diagnostic}`);
        }
        this.emit({
          type: "agent.failed",
          runId,
          message: actionableQwenError(message, diagnostic),
          timestamp: Date.now(),
        });
      }
    } finally {
      this.permissions.denyAll();
      await this.closeActiveQuery(turn);
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      this.logger.debug(`Turn disposed: turnId=${runId}.`);
    }
  }

  async restoreSession(
    request: AgentSessionRestoreRequest,
  ): Promise<AgentSessionRestoreResult> {
    if (this.activeTurn !== undefined) {
      throw new Error("A Qwen operation is already running.");
    }
    const diagnostics = new QwenDiagnosticCapture(
      this.runtimeDiagnostics?.secrets ?? [],
    );
    const options = this.createQueryOptions(
      {
        prompt: "",
        workspacePath: request.workspacePath,
        sessionId: request.sessionId,
        resume: true,
      },
      new AbortController(),
      true,
      diagnostics,
      undefined,
    );
    const activeQuery = this.queryFactory({
      prompt: createIdlePrompt(),
      options,
    });
    try {
      await activeQuery.initialized;
      const contextUsage = adaptQwenContextUsage(
        await activeQuery.getContextUsage(false),
      );
      this.logger.debug(
        `Qwen session restored without inference: sessionId=${request.sessionId}.`,
      );
      return contextUsage === undefined ? {} : { contextUsage };
    } catch (error) {
      const diagnostic = diagnostics.summary();
      throw new Error(actionableQwenError(toErrorMessage(error), diagnostic), {
        cause: error,
      });
    } finally {
      await activeQuery
        .close()
        .catch((error: unknown) =>
          this.logger.debug(
            `Qwen session restore close reported: ${toErrorMessage(error)}`,
          ),
        );
    }
  }

  async cancel(): Promise<void> {
    const turn = this.activeTurn;
    if (turn === undefined) {
      return;
    }
    turn.cancellationRequested = true;
    this.permissions.denyAll();
    this.logger.debug(`Cancellation requested: turnId=${turn.runId}.`);
    const activeQuery = turn.query;
    if (activeQuery === undefined) {
      // There is no SDK query to interrupt yet. Aborting this per-turn
      // controller prevents a query that is still being constructed from
      // starting, but never abort a live query before its supported interrupt
      // request has had a chance to reach Qwen Code.
      turn.abortController.abort();
      this.logger.debug(
        `Abort signal triggered before query creation: turnId=${turn.runId}.`,
      );
      return;
    }
    if (activeQuery.isClosed()) {
      return;
    }
    try {
      await activeQuery.interrupt();
      this.logger.debug(
        `Qwen interrupt accepted: turnId=${turn.runId}; session retained for resume sessionId=${turn.sessionId}.`,
      );
    } catch (error: unknown) {
      this.logger.debug(
        `Qwen interrupt reported: ${toErrorMessage(error)}; aborting the turn transport as a fallback.`,
      );
      turn.abortController.abort();
      this.logger.debug(`Abort signal triggered: turnId=${turn.runId}.`);
    }
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.listeners.clear();
  }

  private createQueryOptions(
    request: AgentRunRequest,
    abortController: AbortController,
    resume: boolean,
    diagnostics: QwenDiagnosticCapture,
    subagents: QwenSubagentResolution | undefined,
  ): QueryOptions {
    const configuration = this.configuration();
    const cliLaunch = resolveCliLaunch(
      configuration.executablePath,
      this.runtimeDiagnostics?.cliExecutable,
    );
    return {
      cwd: request.workspacePath,
      permissionMode: "default",
      includePartialMessages: true,
      abortController,
      canUseTool: async (toolName, input, { signal }) => {
        if (
          !configuration.allowImageInput &&
          isImageReadTool(toolName, input)
        ) {
          return {
            behavior: "deny",
            message:
              "Image input is disabled because the configured model may not support it. Continue with text-based files, or enable qwenFrontend.qwen.allowImageInput after selecting a vision-capable model.",
          };
        }
        return this.requestToolPermission(toolName, input, signal);
      },
      stderr: (message) => {
        const safeMessage = diagnostics.add(message);
        if (safeMessage !== undefined) {
          this.logger.debug(safeMessage);
        }
      },
      debug: configuration.debug,
      // The SDK forwards child stderr through its debug logger. Capture at that
      // level even when verbose output is disabled, then expose only a safe
      // failure summary unless qwenFrontend.debug is enabled.
      logLevel: "debug",
      ...(cliLaunch.executablePath === undefined
        ? {}
        : { pathToQwenExecutable: cliLaunch.executablePath }),
      ...(cliLaunch.targetPath === undefined
        ? {}
        : {
            env: {
              [CLI_TARGET_ENVIRONMENT_VARIABLE]: cliLaunch.targetPath,
              ...(configuration.debug
                ? { QWEN_FRONTEND_LAUNCH_DEBUG: "1" }
                : {}),
            },
          }),
      ...(subagents?.agents === undefined
        ? {}
        : { agents: [...subagents.agents] }),
      ...(request.workspacePaths === undefined ||
      request.workspacePaths.length <= 1
        ? {}
        : { includeDirectories: [...request.workspacePaths.slice(1)] }),
      ...(resume
        ? { resume: request.sessionId }
        : { sessionId: request.sessionId }),
    };
  }

  private async executeQuery(
    request: AgentRunRequest,
    runId: string,
    turn: ActiveQwenTurn,
    resume: boolean,
    diagnostics: QwenDiagnosticCapture,
  ): Promise<QwenExecutionResult> {
    const adapter = new QwenEventAdapter();
    const subagents = await this.resolveSubagents(request.workspacePath);
    const options = this.createQueryOptions(
      request,
      turn.abortController,
      resume,
      diagnostics,
      subagents,
    );
    const prompt = createControlledPrompt(request.prompt, request.sessionId);
    const activeQuery = this.queryFactory({ prompt: prompt.messages, options });
    turn.query = activeQuery;
    this.logger.debug(
      `Query created: turnId=${turn.runId} sessionId=${request.sessionId} resume=${String(resume)}.`,
    );
    const contextRefresh = new ContextUsageRefreshScheduler(() =>
      this.refreshContextUsage(activeQuery, request.sessionId),
    );
    let resultText: string | undefined;
    let resultUsage: TurnTokenUsage | undefined;
    let lastEmittedTurnUsage: TurnTokenUsage | undefined;
    const callUsages = new Map<string, Usage>();
    contextRefresh.schedule();

    let iteratorCompleted = false;
    try {
      const iterator = activeQuery[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextWithInactivityTimeout(
          iterator.next(),
          this.configuration().streamIdleTimeoutMs ??
            DEFAULT_QWEN_STREAM_IDLE_TIMEOUT_MS,
        );
        if (next.done) {
          break;
        }
        const message = next.value;
        if (this.configuration().debug) {
          this.logger.debug(describeSdkMessageForDebug(message));
        }
        if (message.type === "system" && message.subtype === "init") {
          this.logModelSubagentDiagnostics(message, subagents);
        }
        const events = adapter.adapt(message);
        for (const event of events) {
          this.emit(event);
          if (event.type === "tool.completed" && event.target !== undefined) {
            await this.changes.afterEdit(event.target);
          }
        }
        if (events.some(isContextRefreshBoundary)) {
          contextRefresh.schedule();
        }
        if (message.type === "assistant") {
          const usage = readAssistantUsage(message);
          if (usage !== undefined) {
            callUsages.set(message.uuid, usage);
            const cumulative = aggregateQwenCallUsages([
              ...callUsages.values(),
            ]);
            if (
              cumulative !== undefined &&
              !sameTurnUsage(cumulative, lastEmittedTurnUsage)
            ) {
              lastEmittedTurnUsage = cumulative;
              this.emit({
                type: "turn.usage.updated",
                runId,
                usage: cumulative,
                timestamp: Date.now(),
              });
            }
          }
          contextRefresh.schedule();
        }
        if (message.type === "result") {
          resultText = this.readResult(message);
          resultUsage = adaptQwenTurnUsage(message.usage);
          if (
            resultUsage !== undefined &&
            !sameTurnUsage(resultUsage, lastEmittedTurnUsage)
          ) {
            lastEmittedTurnUsage = resultUsage;
            this.emit({
              type: "turn.usage.updated",
              runId,
              usage: resultUsage,
              timestamp: Date.now(),
            });
          }
          await contextRefresh.flush();
          prompt.finish();
        }
      }
      iteratorCompleted = true;
    } finally {
      contextRefresh.stop();
      prompt.finish();
      this.logger.debug(
        `Query iterator ended: turnId=${turn.runId} reason=${turn.cancellationRequested ? "cancelled" : iteratorCompleted ? "completed" : "error"}.`,
      );
    }
    const turnUsage =
      resultUsage ?? aggregateQwenCallUsages([...callUsages.values()]);
    if (turnUsage !== undefined) {
      this.logger.debug(
        `Turn usage: input=${String(turnUsage.inputTokens)} output=${String(turnUsage.outputTokens)} cacheRead=${String(turnUsage.cacheReadInputTokens)} cacheCreation=${String(turnUsage.cacheCreationInputTokens)}.`,
      );
    }
    return {
      ...(resultText === undefined ? {} : { text: resultText }),
      ...(turnUsage === undefined ? {} : { turnUsage }),
    };
  }

  private async resolveSubagents(
    workspacePath: string,
  ): Promise<QwenSubagentResolution | undefined> {
    const runtime = this.runtimeDiagnostics;
    if (runtime === undefined) {
      return undefined;
    }
    const key = `${runtime.cliExecutable}\u0000${workspacePath}`;
    const cached = this.subagentResolutions.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const resolution = await this.subagentResolver(runtime, workspacePath);
    this.subagentResolutions.set(key, resolution);
    for (const line of formatQwenSubagentDiagnostics(resolution.diagnostics)) {
      this.logger.info(line);
    }
    return resolution;
  }

  private logModelSubagentDiagnostics(
    message: Extract<SDKMessage, { type: "system" }>,
    resolution: QwenSubagentResolution | undefined,
  ): void {
    const toolAvailable = message.tools?.includes("agent")
      ? "yes"
      : message.tools === undefined
        ? "unavailable"
        : "no";
    const modelNames = message.agents ?? "unavailable";
    this.logger.info(`Agent tool available: ${toolAvailable}`);
    this.logger.info(
      `Subagent names visible to model: ${formatSubagentNames(modelNames)}`,
    );
    if (resolution !== undefined) {
      this.logger.info(
        `Subagent names available to runtime: ${formatSubagentNames(resolution.diagnostics.runtimeAgentNames)}`,
      );
    }
  }

  private async refreshContextUsage(
    activeQuery: Query,
    sessionId: string,
  ): Promise<void> {
    try {
      const usage = adaptQwenContextUsage(
        await activeQuery.getContextUsage(false),
      );
      if (usage === undefined) {
        this.logger.debug("Qwen returned no usable context metrics.");
        return;
      }
      this.logger.debug(
        `Context usage: used=${String(usage.usedTokens)} window=${String(usage.contextWindowTokens)} percentage=${usage.usedPercentage.toFixed(2)} accuracy=${usage.accuracy}.`,
      );
      this.emit({
        type: "context.usage.updated",
        sessionId,
        usage,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.debug(
        `Unable to refresh Qwen context metrics: ${toErrorMessage(error)}`,
      );
    }
  }

  private async closeActiveQuery(turn: ActiveQwenTurn): Promise<void> {
    const activeQuery = turn.query;
    turn.query = undefined;
    if (activeQuery !== undefined && !activeQuery.isClosed()) {
      await activeQuery
        .close()
        .catch((error: unknown) =>
          this.logger.debug(
            `Qwen query close reported: ${toErrorMessage(error)}`,
          ),
        );
    }
    if (activeQuery !== undefined) {
      this.logger.debug(`Query disposed: turnId=${turn.runId}.`);
    }
  }

  private async requestToolPermission(
    toolName: string,
    input: ToolInput,
    signal: AbortSignal,
  ): Promise<
    | { behavior: "allow"; updatedInput: ToolInput }
    | { behavior: "deny"; message: string }
  > {
    const presentation = describeTool(toolName, input);
    const decision = await this.permissions.request(
      {
        id: randomUUID(),
        toolName,
        title: `Allow ${presentation.title}?`,
        risk: classifyToolRisk(toolName, input),
        ...(presentation.detail === undefined
          ? {}
          : { detail: presentation.detail }),
        input,
      },
      signal,
    );
    if (decision === "deny") {
      return { behavior: "deny", message: "The user denied this operation." };
    }

    const editTarget = getEditTarget(toolName, input);
    if (editTarget !== undefined) {
      try {
        await this.changes.beforeEdit(editTarget);
      } catch (error) {
        return {
          behavior: "deny",
          message: `The extension could not safely snapshot this edit: ${toErrorMessage(error)}`,
        };
      }
    }
    return { behavior: "allow", updatedInput: input };
  }

  private readResult(message: SDKResultMessage): string | undefined {
    if (message.subtype === "success") {
      return message.result;
    }
    if (message.error?.message !== undefined) {
      throw new Error(message.error.message);
    }
    throw new Error(`Qwen ended with ${message.subtype}.`);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          `Agent event listener failed for ${event.type}.`,
          error,
        );
      }
    }
  }

  private async safelyCompleteTrackedChanges(): Promise<void> {
    await this.changes
      .completeAll()
      .catch((error: unknown) =>
        this.logger.error("Unable to finalize tracked file changes.", error),
      );
  }
}

interface ActiveQwenTurn {
  readonly runId: string;
  readonly sessionId: string;
  readonly abortController: AbortController;
  query: Query | undefined;
  cancellationRequested: boolean;
}

interface QwenExecutionResult {
  readonly text?: string;
  readonly turnUsage?: TurnTokenUsage;
}

class QwenStreamInactivityError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Qwen Code stopped receiving messages for ${String(timeoutMs)} ms. The model provider may have ended the stream without a final result.`,
    );
    this.name = "QwenStreamInactivityError";
  }
}

interface ControlledPrompt {
  readonly messages: AsyncIterable<SDKUserMessage>;
  finish(): void;
}

function createControlledPrompt(
  text: string,
  sessionId: string,
): ControlledPrompt {
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    messages: (async function* (): AsyncIterable<SDKUserMessage> {
      yield {
        type: "user",
        session_id: sessionId,
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      };
      await finished;
    })(),
    finish: () => finish?.(),
  };
}

function nextWithInactivityTimeout<T>(
  next: Promise<IteratorResult<T>>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  if (timeoutMs <= 0) {
    return next;
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new QwenStreamInactivityError(timeoutMs)),
      timeoutMs,
    );
    void next.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(toError(error));
      },
    );
  });
}

async function* createIdlePrompt(): AsyncIterable<SDKUserMessage> {
  yield* [];
  await new Promise<void>(() => undefined);
}

async function waitForRuntimeCleanup(): Promise<void> {
  // SDK 0.1.8 escalates process shutdown after five seconds. A retry before
  // that boundary can race the global Qwen extension-store lock.
  await new Promise<void>((resolve) => setTimeout(resolve, 5_250));
}

function isExtensionStoreBusy(
  error: unknown,
  diagnostics: QwenDiagnosticCapture,
): boolean {
  return (
    diagnostics.containsExtensionStoreBusy() ||
    /Extension store is busy at/iu.test(toErrorMessage(error))
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(toErrorMessage(error));
}

function isImageReadTool(toolName: string, input: ToolInput): boolean {
  return (
    /(?:^|[_-])(?:read|view)(?:[_-]|$)/iu.test(toolName) &&
    containsImagePath(input)
  );
}

function containsImagePath(value: unknown): boolean {
  if (typeof value === "string") {
    return IMAGE_FILE_PATH.test(value.trim());
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsImagePath(item));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.values(value).some((item) => containsImagePath(item));
}

function readAssistantUsage(message: SDKAssistantMessage): Usage | undefined {
  const usage = (message.message as { readonly usage?: Usage }).usage;
  if (usage === undefined) {
    return undefined;
  }
  const reportedTokens =
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  // The bundled CLI emits zero-filled placeholder usage when it splits one
  // model response into thinking/tool/text assistant messages.
  return reportedTokens === 0 ? undefined : usage;
}

function isContextRefreshBoundary(event: AgentEvent): boolean {
  return (
    event.type === "assistant.message.completed" ||
    event.type === "thinking.completed" ||
    event.type === "tool.started" ||
    event.type === "tool.completed"
  );
}

function sameTurnUsage(
  left: TurnTokenUsage,
  right: TurnTokenUsage | undefined,
): boolean {
  return (
    right !== undefined &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadInputTokens === right.cacheReadInputTokens &&
    left.cacheCreationInputTokens === right.cacheCreationInputTokens &&
    left.totalTokens === right.totalTokens
  );
}

export function describeSdkMessageForDebug(message: SDKMessage): string {
  const parent =
    "parent_tool_use_id" in message && message.parent_tool_use_id !== null
      ? "yes"
      : "no";
  if (message.type === "stream_event") {
    const detail =
      message.event.type === "content_block_delta"
        ? ` delta=${message.event.delta.type}`
        : message.event.type === "content_block_start"
          ? ` block=${message.event.content_block.type}`
          : "";
    return `Qwen SDK event: type=stream_event event=${message.event.type}${detail} parent=${parent}.`;
  }
  if (message.type === "assistant") {
    const blockTypes = message.message.content
      .map((block) => block.type)
      .join(",");
    return `Qwen SDK event: type=assistant blocks=[${blockTypes}] usage=yes parent=${parent}.`;
  }
  return `Qwen SDK event: type=${message.type} parent=${parent}.`;
}

interface QwenCliLaunch {
  readonly executablePath?: string;
  readonly targetPath?: string;
}

export function resolveCliLaunch(
  configuredPath: string | undefined,
  resolvedPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  electronVersion: string | undefined = process.versions.electron,
  launcherPath: string = join(
    typeof __dirname === "string" ? __dirname : process.cwd(),
    "qwen-cli-launcher.mjs",
  ),
): QwenCliLaunch {
  const executablePath = resolvedPath ?? configuredPath;
  if (
    platform === "win32" &&
    electronVersion !== undefined &&
    executablePath !== undefined &&
    [".js", ".mjs", ".cjs"].includes(extname(executablePath).toLowerCase())
  ) {
    return { executablePath: launcherPath, targetPath: executablePath };
  }
  return configuredPath === undefined ? {} : { executablePath: configuredPath };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSubagentNames(names: readonly string[] | "unavailable"): string {
  return names === "unavailable"
    ? "unavailable"
    : names.length === 0
      ? "none"
      : names.join(", ");
}
