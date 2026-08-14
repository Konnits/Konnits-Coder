import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { AgentClient } from "../agent/AgentClient.js";
import type { AgentEvent } from "../agent/AgentEvent.js";
import {
  EstimatedTokenCounter,
  type ContextTokenUsage,
  type MessageTokenCount,
  type TokenCounter,
  type TurnTokenUsage,
} from "../agent/TokenUsage.js";
import type { ChangeManager } from "../changes/ChangeManager.js";
import type { DiffContentProvider } from "../changes/DiffContentProvider.js";
import type { VsCodeFileSystem } from "../changes/VsCodeFileSystem.js";
import type { Logger } from "../logging/Logger.js";
import type {
  ModelManagement,
  ModelSelectorViewState,
} from "../models/ModelTypes.js";
import type { PermissionManager } from "../permissions/PermissionManager.js";
import type { QwenSessionManager } from "../qwen/QwenSessionManager.js";
import {
  parseWebviewMessage,
  type AppState,
  type ExecutionStatus,
  type TimelineItem,
  type ToolTimelineItem,
  type WebviewToExtensionMessage,
} from "../webview/messages.js";

export class ChatController implements vscode.Disposable {
  private readonly timeline: TimelineItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly disposables: { dispose(): void }[] = [];
  private status: ExecutionStatus = "idle";
  private connected = false;
  private sessionId: string | undefined;
  private contextUsage: ContextTokenUsage | undefined;
  private contextSessionId: string | undefined;
  private modelState: ModelSelectorViewState = {
    label: "Loading model…",
    configuredCount: 0,
  };

  constructor(
    private readonly agent: AgentClient,
    private readonly sessions: QwenSessionManager,
    private readonly permissions: PermissionManager,
    private readonly changes: ChangeManager,
    private readonly fileSystem: VsCodeFileSystem,
    private readonly diff: DiffContentProvider,
    private readonly logger: Logger,
    private readonly tokenCounter: TokenCounter = new EstimatedTokenCounter(),
    private readonly models?: ModelManagement,
  ) {
    this.disposables.push(
      this.agent.onEvent((event) => this.handleAgentEvent(event)),
      this.permissions.onDidChange(() => this.handlePermissionsChanged()),
      this.changes.onDidChange(() => this.emitChange()),
    );
  }

  getState(): AppState {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return {
      status: this.status,
      trusted: vscode.workspace.isTrusted,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(this.contextUsage === undefined ||
      this.contextSessionId !== this.sessionId
        ? {}
        : { contextUsage: this.contextUsage }),
      model: this.modelState,
      timeline: [...this.timeline],
      changes: this.changes.list().map((change) => ({
        id: change.id,
        path: this.fileSystem.displayPath(change.uri),
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        ...(change.conflictReason === undefined
          ? {}
          : { conflictReason: change.conflictReason }),
      })),
      permissions: this.permissions.list().map((permission) => ({
        id: permission.id,
        toolName: permission.toolName,
        title: permission.title,
        risk: permission.risk,
        ...(permission.detail === undefined
          ? {}
          : { detail: permission.detail }),
      })),
    };
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  handleMessage(value: unknown): void {
    const message = parseWebviewMessage(value);
    if (message === undefined) {
      this.logger.error("Ignored malformed message from the Qwen webview.");
      return;
    }
    void this.dispatch(message);
  }

  async connect(): Promise<boolean> {
    this.requireTrustedWorkspace();
    if (this.connected) {
      this.setStatus("connected");
      return true;
    }
    this.setStatus("connecting");
    try {
      await this.agent.connect();
      this.connected = true;
      this.setStatus("connected");
      return true;
    } catch (error) {
      this.addError(toErrorMessage(error));
      this.setStatus("failed");
      return false;
    }
  }

  async newSession(): Promise<void> {
    if (isBusy(this.status)) {
      await vscode.window.showWarningMessage(
        "Cancel the active Qwen operation before starting a new session.",
      );
      return;
    }
    const session = await this.sessions.create();
    this.sessionId = session.id;
    this.contextUsage = undefined;
    this.contextSessionId = undefined;
    this.timeline.length = 0;
    this.changes.clearSettled();
    this.setStatus(this.connected ? "connected" : "idle");
  }

  async manageModels(): Promise<void> {
    await this.runModelAction(() => this.models?.showPicker());
  }

  async addModel(): Promise<void> {
    await this.runModelAction(() => this.models?.addModel());
  }

  async openModelSettings(): Promise<void> {
    await this.models?.openSettings();
  }

  private async runModelAction(
    action: () => Promise<{ readonly modelChanged: boolean }> | undefined,
  ): Promise<void> {
    if (isBusy(this.status)) {
      await vscode.window.showWarningMessage(
        "Cancel the active Qwen operation before changing models.",
      );
      return;
    }
    if (this.models === undefined) {
      await vscode.window.showErrorMessage(
        "Qwen model management is unavailable.",
      );
      return;
    }
    const pending = action();
    if (pending === undefined) {
      return;
    }
    const result = await pending;
    await this.refreshModels();
    if (result.modelChanged) {
      await this.newSession();
      await vscode.window.showInformationMessage(
        `Switched to ${this.modelState.label}. A new Qwen session was started.`,
      );
    }
  }

  refreshTrust(): void {
    this.emitChange();
  }

  dispose(): void {
    this.permissions.denyAll();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.listeners.clear();
  }

  private async dispatch(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.refreshModels();
          break;
        case "connect":
          await this.connect();
          break;
        case "sendPrompt":
          await this.sendPrompt(message.prompt);
          break;
        case "cancel":
          await this.cancel();
          break;
        case "newSession":
          await this.newSession();
          break;
        case "manageModels":
          await this.manageModels();
          break;
        case "addModel":
          await this.addModel();
          break;
        case "openModelSettings":
          await this.openModelSettings();
          break;
        case "reviewFile":
          await this.reviewFile(message.id);
          break;
        case "acceptFile":
          await this.applyChangeAction(() => this.changes.accept(message.id));
          break;
        case "rejectFile":
          await this.applyChangeAction(() => this.changes.reject(message.id));
          break;
        case "acceptAll":
          await this.changes.acceptAll();
          break;
        case "rejectAll":
          await this.changes.rejectAll();
          break;
        case "openExternal":
          await this.openExternal(message.href);
          break;
        case "resolvePermission":
          this.permissions.resolve(message.id, message.decision);
          break;
      }
    } catch (error) {
      const text = toErrorMessage(error);
      this.logger.error("Qwen Frontend action failed.", error);
      this.addError(text);
      await vscode.window.showErrorMessage(text);
    }
  }

  private async sendPrompt(rawPrompt: string): Promise<void> {
    const prompt = rawPrompt.trim();
    if (prompt.length === 0 || isBusy(this.status)) {
      return;
    }
    this.requireTrustedWorkspace();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      throw new Error(
        "Open a workspace folder before sending a coding request.",
      );
    }
    if (!this.connected && !(await this.connect())) {
      return;
    }

    const selection = await this.sessions.getOrCreate();
    if (this.sessionId !== selection.session.id) {
      this.contextUsage = undefined;
      this.contextSessionId = undefined;
    }
    this.sessionId = selection.session.id;
    const tokenCount = this.safeCountTokens(prompt);
    this.timeline.push({
      type: "user",
      id: randomUUID(),
      text: prompt,
      ...(tokenCount === undefined ? {} : { tokenCount }),
    });
    this.emitChange();
    await this.agent.run({
      prompt,
      workspacePath: folder.uri.fsPath,
      sessionId: selection.session.id,
      resume: selection.resume,
    });
    if (this.status === "completed") {
      await this.sessions.markEstablished(selection.session.id);
    }
  }

  private async cancel(): Promise<void> {
    if (!isBusy(this.status)) {
      return;
    }
    this.setStatus("cancelling");
    await this.agent.cancel();
  }

  private async reviewFile(id: string): Promise<void> {
    const change = this.changes.get(id);
    if (change === undefined) {
      throw new Error("That Qwen file change is no longer available.");
    }
    await this.diff.review(change, this.fileSystem.displayPath(change.uri));
  }

  private async applyChangeAction(
    action: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      await vscode.window.showWarningMessage(toErrorMessage(error));
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent.started":
        if (this.sessionId !== event.sessionId) {
          this.contextUsage = undefined;
          this.contextSessionId = undefined;
        }
        this.sessionId = event.sessionId;
        this.setStatus("running");
        return;
      case "assistant.message.started":
        if (
          !this.timeline.some(
            (item) => item.type === "assistant" && item.id === event.messageId,
          )
        ) {
          this.timeline.push({
            type: "assistant",
            id: event.messageId,
            text: "",
            complete: false,
          });
        }
        break;
      case "assistant.message.chunk":
        this.updateAssistant(
          event.messageId,
          (text) => text + event.text,
          false,
        );
        break;
      case "assistant.message.completed":
        this.updateAssistant(event.messageId, (text) => text, true);
        break;
      case "tool.started":
        this.timeline.push({
          type: "tool",
          id: event.callId,
          kind: event.kind,
          title: event.title,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          state: "running",
        });
        break;
      case "tool.completed":
        this.updateTool(event.callId, {
          state: event.success ? "succeeded" : "failed",
          ...(event.output === undefined ? {} : { output: event.output }),
        });
        break;
      case "context.usage.updated":
        if (event.sessionId === this.sessionId) {
          this.contextUsage = event.usage;
          this.contextSessionId = event.sessionId;
          this.emitChange();
        }
        return;
      case "agent.completed":
        this.promoteFinalResponse(event.runId, event.result, event.turnUsage);
        this.setStatus("completed");
        return;
      case "agent.failed":
        this.addError(event.message);
        this.setStatus("failed");
        return;
      case "agent.cancelled":
        this.setStatus("connected");
        return;
    }
    this.emitChange();
  }

  private updateAssistant(
    id: string,
    update: (text: string) => string,
    complete: boolean,
  ): void {
    const index = this.timeline.findIndex(
      (item) => item.type === "assistant" && item.id === id,
    );
    if (index === -1) {
      this.timeline.push({ type: "assistant", id, text: update(""), complete });
      return;
    }
    const item = this.timeline[index];
    if (item?.type === "assistant") {
      this.timeline[index] = { ...item, text: update(item.text), complete };
    }
  }

  private updateTool(
    id: string,
    update: Pick<ToolTimelineItem, "state" | "output">,
  ): void {
    const index = this.timeline.findIndex(
      (item) => item.type === "tool" && item.id === id,
    );
    const item = this.timeline[index];
    if (item?.type === "tool") {
      this.timeline[index] = {
        ...item,
        state: update.state,
        ...(update.output === undefined ? {} : { output: update.output }),
      };
    }
  }

  private promoteFinalResponse(
    runId: string,
    result: string | undefined,
    turnUsage: TurnTokenUsage | undefined,
  ): void {
    const turnStart = findLastTimelineIndex(
      this.timeline,
      (item) => item.type === "user",
    );
    const assistantIndex = findLastTimelineIndex(
      this.timeline,
      (item, index) =>
        index > turnStart &&
        item.type === "assistant" &&
        (result === undefined || item.text === result),
    );
    const assistant = this.timeline[assistantIndex];
    const text =
      result ?? (assistant?.type === "assistant" ? assistant.text : "");
    if (text.length === 0) {
      return;
    }
    const tokenCount = this.safeCountTokens(text);
    const finalResponse = {
      type: "finalResponse" as const,
      id: assistant?.type === "assistant" ? assistant.id : `final-${runId}`,
      text,
      ...(tokenCount === undefined ? {} : { tokenCount }),
      ...(turnUsage === undefined ? {} : { turnUsage }),
    };
    if (assistant?.type === "assistant") {
      this.timeline.splice(assistantIndex, 1, finalResponse);
    } else {
      this.timeline.push(finalResponse);
    }
  }

  private safeCountTokens(text: string): MessageTokenCount | undefined {
    try {
      const count = this.tokenCounter.count(text);
      this.logger.debug(
        `Message token count: tokens=${String(count.tokens)} accuracy=${count.accuracy}.`,
      );
      return count;
    } catch (error) {
      this.logger.debug(
        `Unable to estimate visible message tokens: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async openExternal(href: string): Promise<void> {
    const uri = vscode.Uri.parse(href, true);
    if (!new Set(["http", "https", "mailto"]).has(uri.scheme.toLowerCase())) {
      throw new Error(
        `Qwen produced an unsupported link: ${uri.scheme || "unknown"}.`,
      );
    }
    await vscode.env.openExternal(uri);
  }

  private handlePermissionsChanged(): void {
    if (this.permissions.list().length > 0) {
      this.status = "waitingForPermission";
    } else if (this.status === "waitingForPermission") {
      this.status = "running";
    }
    this.emitChange();
  }

  private requireTrustedWorkspace(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error(
        "Qwen execution is disabled in Restricted Mode. Trust this workspace to continue.",
      );
    }
  }

  private addError(message: string): void {
    this.timeline.push({ type: "error", id: randomUUID(), message });
    this.emitChange();
  }

  private setStatus(status: ExecutionStatus): void {
    this.status = status;
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async refreshModels(): Promise<void> {
    if (this.models === undefined) {
      this.modelState = { label: "Model unavailable", configuredCount: 0 };
      this.emitChange();
      return;
    }
    try {
      this.modelState = await this.models.loadState();
    } catch (error) {
      this.modelState = {
        label: "Model settings error",
        configuredCount: 0,
        error: toErrorMessage(error),
      };
    }
    this.emitChange();
  }
}

function isBusy(status: ExecutionStatus): boolean {
  return (
    status === "connecting" ||
    status === "running" ||
    status === "waitingForPermission" ||
    status === "cancelling"
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findLastTimelineIndex(
  timeline: readonly TimelineItem[],
  predicate: (item: TimelineItem, index: number) => boolean,
): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item !== undefined && predicate(item, index)) {
      return index;
    }
  }
  return -1;
}

export { parseWebviewMessage };
