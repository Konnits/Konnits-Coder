import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatController } from "./ChatController.js";
import type { SlashCommandRegistry } from "../commands/SlashCommandRegistry.js";
import type {
  ExtensionToWebviewMessage,
  AttachmentSelectionMessage,
  SlashCommandsMessage,
  WorkspaceReferencesMessage,
  WebviewToExtensionMessage,
} from "../webview/messages.js";
import { parseWebviewMessage } from "../webview/messages.js";
import type { WorkspaceReferenceService } from "./WorkspaceReferenceService.js";
import type { ChatAttachmentService } from "./ChatAttachmentService.js";

export class ChatViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewType = "qwenFrontend.chat";
  private view: vscode.WebviewView | undefined;
  private readonly stateSubscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly commands: SlashCommandRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly attachments: ChatAttachmentService,
  ) {
    this.stateSubscription = controller.onDidChange(() => {
      void this.postState();
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri],
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((message: unknown) => {
      const parsed = parseWebviewMessage(message);
      if (parsed === undefined) {
        this.controller.handleMessage(message);
        return;
      }
      if (parsed.type === "requestSlashCommands") {
        void this.postSlashCommands();
      } else if (parsed.type === "searchWorkspaceReferences") {
        void this.postWorkspaceReferences(parsed.requestId, parsed.query);
      } else if (parsed.type === "pickAttachments") {
        void this.pickAttachments(parsed.requestId);
      } else if (parsed.type === "saveClipboardImage") {
        void this.saveClipboardImage(parsed);
      } else {
        this.controller.handleMessage(parsed);
      }
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    void this.postState();
  }

  dispose(): void {
    this.stateSubscription.dispose();
    this.view = undefined;
  }

  refreshCommands(): void {
    void this.postSlashCommands();
  }

  private async postState(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    const message: ExtensionToWebviewMessage = {
      type: "state",
      state: this.controller.getState(),
    };
    await this.view.webview.postMessage(message);
  }

  private async postSlashCommands(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    const workspacePaths = folders?.map((folder) => folder.uri.fsPath) ?? [];
    const message: SlashCommandsMessage = {
      type: "slashCommands",
      commands: await this.commands.list({
        ...(workspacePaths[0] === undefined
          ? {}
          : { workspacePath: workspacePaths[0] }),
        workspacePaths,
      }),
    };
    await this.postMessage(message);
  }

  private async postWorkspaceReferences(
    requestId: string,
    query: string,
  ): Promise<void> {
    let message: WorkspaceReferencesMessage;
    try {
      message = {
        type: "workspaceReferences",
        requestId,
        references: await this.references.search(query),
      };
    } catch (error) {
      message = {
        type: "workspaceReferences",
        requestId,
        references: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.postMessage(message);
  }

  private async pickAttachments(requestId: string): Promise<void> {
    try {
      await this.postAttachmentSelection({
        type: "attachmentsSelected",
        requestId,
        attachments: await this.attachments.pickFiles(),
      });
    } catch (error) {
      await this.postAttachmentSelection({
        type: "attachmentsSelected",
        requestId,
        attachments: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveClipboardImage(
    message: Extract<
      WebviewToExtensionMessage,
      { readonly type: "saveClipboardImage" }
    >,
  ): Promise<void> {
    try {
      const attachment = await this.attachments.saveClipboardImage(message);
      await this.postAttachmentSelection({
        type: "attachmentsSelected",
        requestId: message.requestId,
        attachments: [attachment],
      });
    } catch (error) {
      await this.postAttachmentSelection({
        type: "attachmentsSelected",
        requestId: message.requestId,
        attachments: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async postAttachmentSelection(
    message: AttachmentSelectionMessage,
  ): Promise<void> {
    await this.postMessage(message);
  }

  private async postMessage(message: ExtensionToWebviewMessage): Promise<void> {
    if (this.view !== undefined) {
      await this.view.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"),
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Qwen Frontend</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
