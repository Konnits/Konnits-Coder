import * as vscode from "vscode";
import { ChangeManager } from "./changes/ChangeManager.js";
import { ChangeTrackingService } from "./changes/ChangeTrackingService.js";
import { DiffContentProvider } from "./changes/DiffContentProvider.js";
import { VsCodeFileSystem } from "./changes/VsCodeFileSystem.js";
import { ChatController } from "./chat/ChatController.js";
import { ChatViewProvider } from "./chat/ChatViewProvider.js";
import { WorkspaceReferenceService } from "./chat/WorkspaceReferenceService.js";
import { Configuration } from "./configuration/Configuration.js";
import { Logger } from "./logging/Logger.js";
import { ModelManagementController } from "./models/ModelManagementController.js";
import { OpenAICompatibleEndpointProbe } from "./models/OpenAICompatibleEndpointProbe.js";
import { QwenSettingsService } from "./models/QwenSettingsService.js";
import { PermissionManager } from "./permissions/PermissionManager.js";
import { QwenCodeAgentClient } from "./qwen/QwenCodeAgentClient.js";
import { QwenCommandProvider } from "./qwen/QwenCommandProvider.js";
import { QwenSessionManager } from "./qwen/QwenSessionManager.js";
import { QwenSessionHistoryService } from "./qwen/QwenSessionHistoryService.js";

export function activate(context: vscode.ExtensionContext): void {
  const configuration = new Configuration();
  const logger = new Logger(
    vscode.window.createOutputChannel("Qwen Frontend"),
    () => configuration.getQwenClientConfiguration().debug,
  );
  const fileSystem = new VsCodeFileSystem();
  const changes = new ChangeManager(fileSystem);
  const changeTracking = new ChangeTrackingService(changes, fileSystem);
  const permissions = new PermissionManager();
  const agent = new QwenCodeAgentClient(
    () => configuration.getQwenClientConfiguration(),
    permissions,
    changeTracking,
    logger,
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
  const referenceService = new WorkspaceReferenceService();
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
  );
  const view = new ChatViewProvider(
    context.extensionUri,
    controller,
    commandProvider,
    referenceService,
  );

  context.subscriptions.push(
    logger,
    controller,
    view,
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
  );
  logger.info("Qwen Frontend activated.");
}
