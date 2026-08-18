import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { AgentClient } from "../agent/AgentClient.js";
import type { AgentEvent, AgentTodo } from "../agent/AgentEvent.js";
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
import type { KonnitsCommandRouter } from "../commands/KonnitsCommandRouter.js";
import type { QwenSessionManager } from "../qwen/QwenSessionManager.js";
import type {
  QwenSavedSession,
  QwenSessionHistoryService,
} from "../qwen/QwenSessionHistoryService.js";
import { canonicalWorkspacePath } from "../qwen/QwenSessionHistoryService.js";
import { serializeQwenPrompt } from "../qwen/QwenReferenceSerializer.js";
import type { ChatAttachmentAuthorization } from "./ChatAttachmentService.js";
import type { SessionRewind } from "../qwen/QwenSessionRewindService.js";
import {
  parseWebviewMessage,
  type AppState,
  type ChatReference,
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
  private todos: readonly AgentTodo[] = [];
  private readonly todoCheckpoints = new Map<string, readonly AgentTodo[]>();
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
    private readonly history?: QwenSessionHistoryService,
    private readonly commands?: KonnitsCommandRouter,
    private readonly attachments?: ChatAttachmentAuthorization,
    private readonly sessionRewind?: SessionRewind,
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
      timeline: this.timeline.map((item) =>
        item.type === "user" && this.changes.hasCheckpoint(item.id)
          ? {
              ...item,
              canEdit: true,
              ...(this.changes.hasChangesSinceCheckpoint(item.id)
                ? { canRestoreFiles: true }
                : {}),
            }
          : item,
      ),
      todos: this.todos.map((todo) => ({ ...todo })),
      changes: this.changes.list().map((change) => ({
        id: change.id,
        path: this.fileSystem.displayPath(change.uri),
        kind:
          change.originalContent === null
            ? "added"
            : change.proposedContent === null
              ? "deleted"
              : "modified",
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
    this.todos = [];
    this.todoCheckpoints.clear();
    this.timeline.length = 0;
    this.changes.clearCheckpoints();
    this.changes.clearSettled();
    this.setStatus(this.connected ? "connected" : "idle");
  }

  async openHistory(): Promise<void> {
    if (isBusy(this.status)) {
      await vscode.window.showWarningMessage(
        "Cancel the active Qwen operation before opening chat history.",
      );
      return;
    }
    this.requireTrustedWorkspace();
    if (this.history === undefined) {
      await vscode.window.showErrorMessage(
        "Qwen chat history is unavailable in this installation.",
      );
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      await vscode.window.showWarningMessage(
        "Open a workspace folder before viewing Qwen chat history.",
      );
      return;
    }

    const picker = vscode.window.createQuickPick<HistoryPickerItem>();
    picker.title = "Qwen Chat History";
    picker.placeholder = "Search chats…";
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.buttons = [
      {
        iconPath: new vscode.ThemeIcon("clear-all"),
        tooltip: "Clear inactive conversations",
      },
    ];
    let sessions: readonly QwenSavedSession[] = [];
    let closed = false;
    const workspacePaths = folders.map((folder) => folder.uri.fsPath);
    const knownSessionId = (): string | undefined =>
      this.sessionId ?? this.sessions.getKnownSessionId();
    const refresh = async (): Promise<void> => {
      picker.busy = true;
      try {
        sessions =
          (await this.history?.list(workspacePaths, knownSessionId())) ?? [];
        picker.items = sessions.map(toHistoryPickerItem);
      } catch (error) {
        this.logger.error("Unable to load Qwen chat history.", error);
        picker.items = [];
        await vscode.window.showErrorMessage(
          `Unable to load Qwen chat history: ${toErrorMessage(error)}`,
        );
      } finally {
        picker.busy = false;
      }
    };
    picker.onDidAccept(() => {
      const selected = picker.selectedItems[0]?.session;
      if (selected === undefined || closed) {
        return;
      }
      closed = true;
      picker.hide();
      void this.resumeSavedSession(selected);
    });
    picker.onDidTriggerItemButton((event) => {
      if (closed || event.item.session.isCurrent) {
        return;
      }
      void this.deleteSavedSession(event.item.session, refresh);
    });
    picker.onDidTriggerButton(() => {
      if (closed) {
        return;
      }
      void this.clearInactiveHistory(workspacePaths, refresh, sessions);
    });
    picker.onDidHide(() => {
      closed = true;
      picker.dispose();
    });
    await refresh();
    picker.show();
  }

  async manageModels(): Promise<void> {
    await this.runModelAction(() => this.models?.showPicker());
  }

  async addModel(): Promise<void> {
    await this.runModelAction(() => this.models?.addModel());
  }

  private async resumeSavedSession(session: QwenSavedSession): Promise<void> {
    if (this.history === undefined) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    const sessionWorkspace = await canonicalWorkspacePath(session.cwd);
    const folderMatches = await Promise.all(
      (folders ?? []).map(async (candidate) => ({
        candidate,
        matches:
          (await canonicalWorkspacePath(candidate.uri.fsPath)) ===
          sessionWorkspace,
      })),
    );
    const folder = folderMatches.find(({ matches }) => matches)?.candidate;
    if (folder === undefined) {
      await vscode.window.showErrorMessage(
        "The saved Qwen conversation belongs to a workspace that is no longer open.",
      );
      return;
    }
    try {
      const transcript = await this.history.loadTranscript(session);
      if (!this.connected && !(await this.connect())) {
        return;
      }
      if (this.agent.restoreSession === undefined) {
        throw new Error(
          "The active Qwen client cannot restore persisted sessions without inference.",
        );
      }
      const result = await this.agent.restoreSession({
        sessionId: session.sessionId,
        workspacePath: folder.uri.fsPath,
      });
      const selection = await this.sessions.resumeExisting(session.sessionId);
      this.sessionId = selection.session.id;
      this.timeline.splice(0, this.timeline.length, ...transcript);
      this.todos = [];
      this.todoCheckpoints.clear();
      this.changes.clearCheckpoints();
      this.contextUsage = result.contextUsage;
      this.contextSessionId =
        result.contextUsage === undefined ? undefined : session.sessionId;
      this.changes.clearSettled();
      await this.refreshModels();
      this.setStatus("connected");
    } catch (error) {
      this.logger.error(
        `Unable to restore Qwen conversation ${session.sessionId}.`,
        error,
      );
      this.addError(
        `Unable to restore Qwen conversation: ${toErrorMessage(error)}`,
      );
      await vscode.window.showErrorMessage(
        `Unable to restore Qwen conversation: ${toErrorMessage(error)}`,
      );
    }
  }

  private async deleteSavedSession(
    session: QwenSavedSession,
    refresh: () => Promise<void>,
  ): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `Delete the Qwen conversation “${session.title}”? Its saved transcript and Qwen session files will be removed.`,
      { modal: true },
      "Delete",
    );
    if (confirmation !== "Delete" || this.history === undefined) {
      return;
    }
    try {
      await this.history.delete(session);
      await refresh();
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Unable to delete Qwen conversation: ${toErrorMessage(error)}`,
      );
    }
  }

  private async clearInactiveHistory(
    workspacePaths: readonly string[],
    refresh: () => Promise<void>,
    sessions: readonly QwenSavedSession[],
  ): Promise<void> {
    const inactiveCount = sessions.filter(
      (session) => !session.isCurrent,
    ).length;
    if (inactiveCount === 0 || this.history === undefined) {
      await vscode.window.showInformationMessage(
        "There are no inactive Qwen conversations to clear.",
      );
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Clear ${String(inactiveCount)} inactive Qwen conversation${inactiveCount === 1 ? "" : "s"}? Saved transcripts will be removed.`,
      { modal: true },
      "Clear",
    );
    if (confirmation !== "Clear") {
      return;
    }
    try {
      const result = await this.history.deleteInactive(
        workspacePaths,
        this.sessionId ?? this.sessions.getKnownSessionId(),
      );
      await refresh();
      if (result.errors.length > 0) {
        await vscode.window.showWarningMessage(
          `Cleared ${String(result.removed.length)} conversation${result.removed.length === 1 ? "" : "s"}; ${String(result.errors.length)} could not be removed.`,
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Unable to clear Qwen chat history: ${toErrorMessage(error)}`,
      );
    }
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
          await this.sendPrompt(message.prompt, message.references ?? []);
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
        case "openPermissionSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:Konnits.konnits-coder qwenFrontend.qwen.permissionMode",
          );
          break;
        case "retryPrompt":
          await this.retryPrompt(message.id);
          break;
        case "editPrompt":
          await this.editPrompt(
            message.id,
            message.prompt,
            message.references ?? [],
          );
          break;
        case "restorePromptFiles":
          await this.restorePromptFiles(message.id);
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

  private async sendPrompt(
    rawPrompt: string,
    references: readonly ChatReference[],
  ): Promise<void> {
    const prompt = rawPrompt.trim();
    if (prompt.length === 0 && references.length === 0) {
      return;
    }
    this.validateAttachmentReferences(references);
    this.requireTrustedWorkspace();
    if (this.status === "running") {
      await this.sendFollowUp(prompt, references);
      return;
    }
    if (isBusy(this.status)) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.[0];
    if (folders === undefined || folder === undefined) {
      throw new Error(
        "Open a workspace folder before sending a coding request.",
      );
    }
    if (this.commands !== undefined) {
      const route = await this.commands.route(prompt, {
        workspacePath: folder.uri.fsPath,
        workspacePaths: folders.map((workspace) => workspace.uri.fsPath),
      });
      if (route.type === "local") {
        this.timeline.push({
          type: "commandResult",
          id: randomUUID(),
          command: route.result.command,
          title: route.result.title,
          markdown: route.result.markdown,
          status: route.result.status,
        });
        this.emitChange();
        return;
      }
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
    const serializedPrompt = serializeQwenPrompt(prompt, references, {
      primaryWorkspaceFolderUri: folder.uri.toString(),
    });
    const userId = randomUUID();
    await this.changes.captureCheckpoint(userId);
    this.todoCheckpoints.set(
      userId,
      this.todos.map((todo) => ({ ...todo })),
    );
    this.timeline.push({
      type: "user",
      id: userId,
      text: prompt,
      ...(tokenCount === undefined ? {} : { tokenCount }),
      ...(references.length === 0 ? {} : { references: [...references] }),
    });
    this.emitChange();
    const workspacePaths = uniqueStrings([
      ...folders.map((workspace) => workspace.uri.fsPath),
      ...(this.attachments?.additionalWorkspacePaths(references) ?? []),
    ]);
    await this.agent.run({
      prompt: serializedPrompt,
      workspacePath: folder.uri.fsPath,
      ...(workspacePaths.length <= 1 ? {} : { workspacePaths }),
      sessionId: selection.session.id,
      resume: selection.resume,
    });
    if (this.status === "completed") {
      await this.sessions.markEstablished(selection.session.id);
    }
  }

  private async sendFollowUp(
    prompt: string,
    references: readonly ChatReference[],
  ): Promise<void> {
    if (references.some((reference) => reference.source === "attachment")) {
      throw new Error(
        "Attach files before starting a Qwen operation. Active-turn updates can still reference workspace files.",
      );
    }
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.[0];
    if (folders === undefined || folder === undefined) {
      throw new Error(
        "Open a workspace folder before sending a coding request.",
      );
    }
    const serializedPrompt = serializeQwenPrompt(prompt, references, {
      primaryWorkspaceFolderUri: folder.uri.toString(),
    });
    const accepted = await this.agent.sendMessage(serializedPrompt);
    if (!accepted) {
      if (!isBusy(this.status)) {
        await this.sendPrompt(prompt, references);
        return;
      }
      throw new Error(
        "The active Qwen operation can no longer accept another message.",
      );
    }
    const tokenCount = this.safeCountTokens(prompt);
    this.timeline.push({
      type: "followUp",
      id: randomUUID(),
      text: prompt,
      ...(tokenCount === undefined ? {} : { tokenCount }),
      ...(references.length === 0 ? {} : { references: [...references] }),
    });
    this.emitChange();
  }

  private async retryPrompt(id: string): Promise<void> {
    if (isBusy(this.status)) {
      return;
    }
    const item = this.timeline.find(
      (candidate) => candidate.type === "user" && candidate.id === id,
    );
    if (item?.type !== "user") {
      throw new Error("That prompt is no longer available to retry.");
    }
    await this.sendPrompt(item.text, item.references ?? []);
  }

  private async editPrompt(
    id: string,
    rawPrompt: string,
    references: readonly ChatReference[],
  ): Promise<void> {
    if (isBusy(this.status)) {
      return;
    }
    const prompt = rawPrompt.trim();
    if (prompt.length === 0 && references.length === 0) {
      return;
    }
    this.requireTrustedWorkspace();
    this.validateAttachmentReferences(references);
    const targetIndex = this.timeline.findIndex(
      (item) => item.type === "user" && item.id === id,
    );
    if (targetIndex < 0 || !this.changes.hasCheckpoint(id)) {
      throw new Error("That prompt is no longer available to edit.");
    }
    const sessionId = this.sessionId;
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (
      sessionId === undefined ||
      workspacePath === undefined ||
      this.sessionRewind === undefined
    ) {
      throw new Error("The current Qwen session cannot be rewound.");
    }
    const previousStatus = this.status;
    this.setStatus("restoring");
    try {
      await this.changes.assertCheckpointRestorable(id);
      const rollbackCheckpointId = `edit-rollback:${randomUUID()}`;
      await this.changes.captureCheckpoint(rollbackCheckpointId);
      await this.changes.restoreCheckpoint(id);
      const targetTurnIndex = countQwenUserTurns(
        this.timeline.slice(0, targetIndex),
      );
      try {
        await this.sessionRewind.rewind({
          sessionId,
          workspacePath,
          targetTurnIndex,
        });
      } catch (error) {
        try {
          await this.changes.restoreCheckpoint(rollbackCheckpointId);
        } catch (rollbackError) {
          this.logger.error(
            "Unable to recover files after a failed Qwen conversation rewind.",
            rollbackError,
          );
          throw new Error(
            `Qwen could not rewind the conversation, and some files could not be returned to their newer state: ${toErrorMessage(error)}`,
          );
        } finally {
          this.changes.discardCheckpoints([rollbackCheckpointId]);
        }
        throw error;
      }
      this.changes.discardCheckpoints([rollbackCheckpointId]);

      const removedUserIds = this.timeline
        .slice(targetIndex)
        .filter((item) => item.type === "user")
        .map((item) => item.id);
      this.timeline.splice(targetIndex);
      this.todos = (this.todoCheckpoints.get(id) ?? []).map((todo) => ({
        ...todo,
      }));
      this.contextUsage = undefined;
      this.contextSessionId = undefined;
      this.changes.discardCheckpoints(removedUserIds);
      for (const userId of removedUserIds) {
        this.todoCheckpoints.delete(userId);
      }
      this.emitChange();
      this.setStatus(previousStatus);
      await this.sendPrompt(prompt, references);
    } finally {
      if (this.status === "restoring") {
        this.setStatus(previousStatus);
      }
    }
  }

  private async restorePromptFiles(id: string): Promise<void> {
    if (isBusy(this.status) || !this.changes.hasChangesSinceCheckpoint(id)) {
      return;
    }
    this.requireTrustedWorkspace();
    const confirmation = await vscode.window.showWarningMessage(
      "Restore every safely tracked agent file to its state before this prompt? Conversation history will remain unchanged.",
      { modal: true },
      "Restore files",
    );
    if (confirmation !== "Restore files") {
      return;
    }
    const previousStatus = this.status;
    this.setStatus("restoring");
    try {
      await this.changes.restoreCheckpoint(id);
    } finally {
      this.setStatus(previousStatus);
    }
  }

  private validateAttachmentReferences(
    references: readonly ChatReference[],
  ): void {
    for (const reference of references) {
      if (
        reference.source === "attachment" &&
        this.attachments?.isManaged(reference) !== true
      ) {
        throw new Error("That attachment is no longer available.");
      }
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
          this.todos = [];
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
            ...(event.parentId === undefined
              ? {}
              : { parentId: event.parentId }),
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
      case "thinking.started":
        if (
          !this.timeline.some(
            (item) => item.type === "thinking" && item.id === event.thoughtId,
          )
        ) {
          this.timeline.push({
            type: "thinking",
            id: event.thoughtId,
            text: "",
            complete: false,
            startedAt: event.timestamp,
            ...(event.parentId === undefined
              ? {}
              : { parentId: event.parentId }),
          });
        }
        break;
      case "thinking.chunk":
        this.updateThinking(
          event.thoughtId,
          (text) => text + event.text,
          false,
        );
        break;
      case "thinking.completed":
        this.updateThinking(
          event.thoughtId,
          (text) => text,
          true,
          event.durationMs,
        );
        break;
      case "tool.started":
        this.timeline.push({
          type: "tool",
          id: event.callId,
          kind: event.kind,
          title: event.title,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
          ...(event.subagentName === undefined
            ? {}
            : { subagentName: event.subagentName }),
          ...(event.background === undefined
            ? {}
            : { background: event.background }),
          state: "running",
        });
        break;
      case "turn.usage.updated":
        this.updateTurnUsage(event.runId, event.usage);
        break;
      case "tool.completed":
        this.updateTool(event.callId, {
          state: event.success ? "succeeded" : "failed",
          ...(event.output === undefined ? {} : { output: event.output }),
        });
        break;
      case "todos.updated":
        if (event.parentId === undefined) {
          this.todos = event.todos.map((todo) => ({ ...todo }));
        }
        break;
      case "context.usage.updated":
        if (event.sessionId === this.sessionId) {
          this.contextUsage = event.usage;
          this.contextSessionId = event.sessionId;
          this.emitChange();
        }
        return;
      case "agent.completed":
        if (event.turnUsage !== undefined) {
          this.updateTurnUsage(event.runId, event.turnUsage);
        }
        this.promoteFinalResponse(event.runId, event.result, event.turnUsage);
        this.setStatus("completed");
        return;
      case "agent.failed":
        this.addError(event.message);
        this.setStatus("failed");
        return;
      case "agent.cancelled":
        this.markActiveTurnCancelled();
        // A supported Qwen interrupt leaves the persisted session resumable
        // even though the turn did not complete successfully. Record that
        // fact before the next prompt can be accepted; otherwise the session
        // manager starts the next turn with sessionId instead of resume.
        if (this.sessionId !== undefined) {
          void this.sessions
            .markEstablished(this.sessionId)
            .catch((error: unknown) =>
              this.logger.error(
                "Unable to persist the Qwen session after cancellation.",
                error,
              ),
            );
        }
        this.setStatus("idle");
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

  private updateThinking(
    id: string,
    update: (text: string) => string,
    complete: boolean,
    durationMs?: number,
  ): void {
    const index = this.timeline.findIndex(
      (item) => item.type === "thinking" && item.id === id,
    );
    const item = this.timeline[index];
    if (item?.type === "thinking") {
      this.timeline[index] = {
        ...item,
        text: update(item.text),
        complete,
        ...(durationMs === undefined ? {} : { durationMs }),
      };
      return;
    }
    this.timeline.push({
      type: "thinking",
      id,
      text: update(""),
      complete,
      startedAt: Date.now(),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

  private markActiveTurnCancelled(): void {
    const turnStart = findLastTimelineIndex(
      this.timeline,
      (item) => item.type === "user",
    );
    for (let index = turnStart + 1; index < this.timeline.length; index += 1) {
      const item = this.timeline[index];
      if (item?.type === "tool" && item.state === "running") {
        this.timeline[index] = { ...item, state: "cancelled" };
      } else if (
        (item?.type === "assistant" || item?.type === "thinking") &&
        !item.complete
      ) {
        this.timeline[index] = { ...item, complete: true, cancelled: true };
      }
    }
  }

  private updateTurnUsage(runId: string, usage: TurnTokenUsage): void {
    const id = `turn-usage-${runId}`;
    const index = this.timeline.findIndex(
      (item) => item.type === "turnUsage" && item.id === id,
    );
    const item = { type: "turnUsage" as const, id, usage };
    if (index === -1) {
      this.timeline.push(item);
    } else {
      this.timeline[index] = item;
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
        item.parentId === undefined &&
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
    status === "cancelling" ||
    status === "restoring"
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function countQwenUserTurns(timeline: readonly TimelineItem[]): number {
  return timeline.filter(
    (item) => item.type === "user" || item.type === "followUp",
  ).length;
}

interface HistoryPickerItem extends vscode.QuickPickItem {
  readonly session: QwenSavedSession;
}

function toHistoryPickerItem(session: QwenSavedSession): HistoryPickerItem {
  const branch =
    session.gitBranch === undefined
      ? undefined
      : `$(git-branch) ${session.gitBranch}`;
  const current = session.isCurrent ? " · Current" : "";
  return {
    label: session.title,
    description: `${relativeTime(session.updatedAt)}${branch === undefined ? "" : ` · ${branch}`}${current}`,
    ...(session.initialPrompt === undefined ||
    session.initialPrompt === session.title
      ? {}
      : { detail: session.initialPrompt }),
    ...(session.isCurrent
      ? {}
      : {
          buttons: [
            {
              iconPath: new vscode.ThemeIcon("trash"),
              tooltip: "Delete conversation",
            },
          ],
        }),
    session,
  };
}

function relativeTime(timestamp: number, now = Date.now()): string {
  const age = Math.max(0, now - timestamp);
  if (age < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

export { parseWebviewMessage };
