import * as vscode from "vscode";
import { ChangeManager } from "./changes/ChangeManager.js";
import { ChangeTrackingService } from "./changes/ChangeTrackingService.js";
import { DiffContentProvider } from "./changes/DiffContentProvider.js";
import { VsCodeFileSystem } from "./changes/VsCodeFileSystem.js";
import { ChatController } from "./chat/ChatController.js";
import { ChatViewProvider } from "./chat/ChatViewProvider.js";
import { WorkspaceReferenceService } from "./chat/WorkspaceReferenceService.js";
import { ChatAttachmentService } from "./chat/ChatAttachmentService.js";
import { Configuration } from "./configuration/Configuration.js";
import { Logger } from "./logging/Logger.js";
import { ModelManagementController } from "./models/ModelManagementController.js";
import { OpenAICompatibleEndpointProbe } from "./models/OpenAICompatibleEndpointProbe.js";
import { QwenSettingsService } from "./models/QwenSettingsService.js";
import { PermissionManager } from "./permissions/PermissionManager.js";
import {
  AgentPermissionModeService,
  VsCodeAgentPermissionModeHost,
} from "./permissions/AgentPermissionModeService.js";
import { QwenCodeAgentClient } from "./qwen/QwenCodeAgentClient.js";
import { QwenCommandProvider } from "./qwen/QwenCommandProvider.js";
import { QwenSessionManager } from "./qwen/QwenSessionManager.js";
import { QwenSessionHistoryService } from "./qwen/QwenSessionHistoryService.js";
import { QwenSessionRewindService } from "./qwen/QwenSessionRewindService.js";
import { QwenSubagentCatalog } from "./qwen/QwenSubagentRegistry.js";
import { SlashCommandRegistry } from "./commands/SlashCommandRegistry.js";
import { KonnitsCommandRouter } from "./commands/KonnitsCommandRouter.js";
import { registerKonnitsCommands } from "./commands/KonnitsCommands.js";

export function activate(context: vscode.ExtensionContext): void {
  const permissionModes = new AgentPermissionModeService(
    new VsCodeAgentPermissionModeHost(context.workspaceState),
  );
  const configuration = new Configuration(() => permissionModes.current());
  const logger = new Logger(
    vscode.window.createOutputChannel("Qwen Frontend"),
    () => configuration.getQwenClientConfiguration().debug,
  );
  const reconcilePermissionMode = (): void => {
    void permissionModes.reconcile().catch((error: unknown) => {
      logger.error("Unable to reconcile the agent permission mode.", error);
    });
  };
  const fileSystem = new VsCodeFileSystem();
  const changes = new ChangeManager(fileSystem);
  const changeTracking = new ChangeTrackingService(changes, fileSystem);
  const permissions = new PermissionManager();
  const subagents = new QwenSubagentCatalog(() =>
    configuration.getQwenClientConfiguration(),
  );
  const agent = new QwenCodeAgentClient(
    () => configuration.getQwenClientConfiguration(),
    permissions,
    changeTracking,
    logger,
    undefined,
    (runtime, workspacePath) => subagents.resolve(runtime, workspacePath),
  );
  const workspaceKey =
    vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "no-workspace";
  const sessions = new QwenSessionManager(context.workspaceState, workspaceKey);
  const history = new QwenSessionHistoryService(
    () => configuration.getQwenClientConfiguration(),
    logger,
  );
  const diff = new DiffContentProvider(changes);
  const commandProvider = new QwenCommandProvider(
    () => configuration.getQwenClientConfiguration(),
    logger,
  );
  const commandRegistry = new SlashCommandRegistry(commandProvider);
  registerKonnitsCommands(commandRegistry, subagents);
  const commandRouter = new KonnitsCommandRouter(commandRegistry);
  const referenceService = new WorkspaceReferenceService();
  const attachmentRoot = vscode.Uri.joinPath(
    context.storageUri ?? context.globalStorageUri,
    "chat-attachments",
  );
  const attachments = new ChatAttachmentService(attachmentRoot);
  const sessionRewind = new QwenSessionRewindService(() => {
    const executablePath =
      configuration.getQwenClientConfiguration().executablePath;
    return executablePath === undefined ? {} : { executablePath };
  });
  const modelManagement = new ModelManagementController(
    new QwenSettingsService(),
    new OpenAICompatibleEndpointProbe(),
    logger,
  );
  const controller = new ChatController(
    agent,
    sessions,
    permissions,
    changes,
    fileSystem,
    diff,
    logger,
    undefined,
    modelManagement,
    history,
    commandRouter,
    attachments,
    sessionRewind,
    permissionModes,
  );
  const view = new ChatViewProvider(
    context.extensionUri,
    controller,
    commandRegistry,
    referenceService,
    attachments,
  );

  context.subscriptions.push(
    logger,
    controller,
    view,
    attachments,
    permissionModes,
    { dispose: () => void agent.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(
      DiffContentProvider.scheme,
      diff,
    ),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("qwenFrontend.connect", () =>
      controller.connect(),
    ),
    vscode.commands.registerCommand("qwenFrontend.newSession", () =>
      controller.newSession(),
    ),
    vscode.commands.registerCommand("qwenFrontend.openHistory", () =>
      controller.openHistory(),
    ),
    vscode.commands.registerCommand("qwenFrontend.cancel", () =>
      controller.handleMessage({ type: "cancel" }),
    ),
    vscode.commands.registerCommand("qwenFrontend.selectModel", () =>
      controller.handleMessage({ type: "manageModels" }),
    ),
    vscode.commands.registerCommand("qwenFrontend.addModel", () =>
      controller.handleMessage({ type: "addModel" }),
    ),
    vscode.commands.registerCommand("qwenFrontend.manageModels", () =>
      controller.handleMessage({ type: "manageModels" }),
    ),
    vscode.commands.registerCommand("qwenFrontend.openQwenSettings", () =>
      controller.handleMessage({ type: "openModelSettings" }),
    ),
    vscode.workspace.onDidGrantWorkspaceTrust(() => controller.refreshTrust()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("qwenFrontend")) {
        if (event.affectsConfiguration("qwenFrontend.qwen.permissionMode")) {
          reconcilePermissionMode();
        }
        commandRegistry.refresh();
        subagents.refresh();
        view.refreshCommands();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      commandRegistry.refresh();
      subagents.refresh();
      view.refreshCommands();
    }),
  );
  reconcilePermissionMode();
  logger.info("Qwen Frontend activated.");
}
