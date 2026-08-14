import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatController } from "./ChatController.js";
import type { ExtensionToWebviewMessage } from "../webview/messages.js";

export class ChatViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewType = "qwenFrontend.chat";
  private view: vscode.WebviewView | undefined;
  private readonly stateSubscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
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
    webview.onDidReceiveMessage((message: unknown) =>
      this.controller.handleMessage(message),
    );
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    void this.postState();
  }

  dispose(): void {
    this.stateSubscription.dispose();
    this.view = undefined;
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
