import { access } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isAbortError,
  query,
  type Query,
  type QueryOptions,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Usage,
  type ToolInput,
} from "@qwen-code/sdk";
import type {
  AgentClient,
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
  adaptQwenContextUsage,
  adaptQwenTurnUsage,
  aggregateQwenCallUsages,
} from "./QwenTokenUsageAdapter.js";
import type { TurnTokenUsage } from "../agent/TokenUsage.js";

export interface QwenClientConfiguration {
  readonly executablePath?: string;
  readonly debug: boolean;
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

const CLI_TARGET_ENVIRONMENT_VARIABLE = "QWEN_FRONTEND_CLI_TARGET";

export class QwenCodeAgentClient implements AgentClient {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private activeQuery: Query | undefined;
  private activeAbortController: AbortController | undefined;
  private runtimeDiagnostics: QwenRuntimeDiagnostics | undefined;

  constructor(
    private readonly configuration: () => QwenClientConfiguration,
    private readonly permissions: PermissionManager,
    private readonly changes: QwenChangeTracker,
    private readonly logger: QwenClientLogger,
    private readonly queryFactory: QwenQueryFactory = query,
  ) {}

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
    if (this.activeQuery !== undefined) {
      throw new Error("A Qwen operation is already running.");
    }

    const runId = randomUUID();
    const abortController = new AbortController();
    const diagnostics = new QwenDiagnosticCapture(
      this.runtimeDiagnostics?.secrets ?? [],
    );
    this.activeAbortController = abortController;
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
          abortController,
          request.resume,
          diagnostics,
        );
      } catch (error) {
        if (request.resume && diagnostics.containsMissingSession()) {
          this.logger.info(
            "The persisted Qwen session does not exist; retrying once as a new session.",
          );
          await this.closeActiveQuery();
          diagnostics.clear();
          executionResult = await this.executeQuery(
            request,
            abortController,
            false,
            diagnostics,
          );
        } else {
          throw error;
        }
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
      if (isAbortError(error) || abortController.signal.aborted) {
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
      this.activeAbortController = undefined;
      await this.closeActiveQuery();
    }
  }

  async cancel(): Promise<void> {
    const activeQuery = this.activeQuery;
    if (activeQuery === undefined) {
      return;
    }
    this.permissions.denyAll();
    this.activeAbortController?.abort();
    await activeQuery
      .interrupt()
      .catch((error: unknown) =>
        this.logger.debug(`Qwen interrupt reported: ${toErrorMessage(error)}`),
      );
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
      canUseTool: async (toolName, input, { signal }) =>
        this.requestToolPermission(toolName, input, signal),
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
      ...(resume
        ? { resume: request.sessionId }
        : { sessionId: request.sessionId }),
    };
  }

  private async executeQuery(
    request: AgentRunRequest,
    abortController: AbortController,
    resume: boolean,
    diagnostics: QwenDiagnosticCapture,
  ): Promise<QwenExecutionResult> {
    const adapter = new QwenEventAdapter();
    const options = this.createQueryOptions(
      request,
      abortController,
      resume,
      diagnostics,
    );
    const prompt = createControlledPrompt(request.prompt, request.sessionId);
    const activeQuery = this.queryFactory({ prompt: prompt.messages, options });
    this.activeQuery = activeQuery;
    let resultText: string | undefined;
    let resultUsage: TurnTokenUsage | undefined;
    const callUsages: Usage[] = [];

    try {
      for await (const message of activeQuery) {
        for (const event of adapter.adapt(message)) {
          this.emit(event);
          if (event.type === "tool.completed" && event.target !== undefined) {
            await this.changes.afterEdit(event.target);
          }
        }
        if (message.type === "assistant") {
          const usage = readAssistantUsage(message);
          if (usage !== undefined) {
            callUsages.push(usage);
          }
        }
        if (message.type === "result") {
          resultText = this.readResult(message);
          resultUsage = adaptQwenTurnUsage(message.usage);
          await this.refreshContextUsage(activeQuery, request.sessionId);
          prompt.finish();
        }
      }
    } finally {
      prompt.finish();
    }
    const turnUsage = resultUsage ?? aggregateQwenCallUsages(callUsages);
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

  private async closeActiveQuery(): Promise<void> {
    const activeQuery = this.activeQuery;
    this.activeQuery = undefined;
    if (activeQuery !== undefined && !activeQuery.isClosed()) {
      await activeQuery
        .close()
        .catch((error: unknown) =>
          this.logger.debug(
            `Qwen query close reported: ${toErrorMessage(error)}`,
          ),
        );
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

interface QwenExecutionResult {
  readonly text?: string;
  readonly turnUsage?: TurnTokenUsage;
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

function readAssistantUsage(message: SDKAssistantMessage): Usage | undefined {
  return message.message.usage;
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
