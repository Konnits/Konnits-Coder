import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import * as vscode from "vscode";
import type { ChatReference } from "../webview/messages.js";

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export interface ClipboardImageInput {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

export interface ChatAttachmentAuthorization {
  isManaged(reference: ChatReference): boolean;
  additionalWorkspacePaths(
    references: readonly ChatReference[],
  ): readonly string[];
}

export class ChatAttachmentService
  implements ChatAttachmentAuthorization, vscode.Disposable
{
  private readonly managed = new Map<string, ChatReference>();
  private readonly created = new Set<string>();

  constructor(private readonly root: vscode.Uri) {}

  async pickFiles(): Promise<readonly ChatReference[]> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
      title: "Attach files to Qwen",
    });
    if (selected === undefined) {
      return [];
    }
    if (selected.length > MAX_ATTACHMENT_COUNT) {
      throw new Error(
        `Attach at most ${String(MAX_ATTACHMENT_COUNT)} files at a time.`,
      );
    }
    return Promise.all(selected.map((uri) => this.copyFile(uri)));
  }

  async saveClipboardImage(input: ClipboardImageInput): Promise<ChatReference> {
    const extension = IMAGE_EXTENSIONS[input.mimeType];
    if (extension === undefined) {
      throw new Error(`Unsupported clipboard image type: ${input.mimeType}.`);
    }
    const bytes = decodeBase64(input.data);
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES
    ) {
      throw new Error("Clipboard images must be between 1 byte and 10 MB.");
    }
    const displayName = normalizeDisplayName(
      input.name,
      `clipboard${extension}`,
    );
    return this.writeManagedFile(bytes, displayName, extension);
  }

  isManaged(reference: ChatReference): boolean {
    const managed = this.managed.get(reference.id);
    return (
      managed !== undefined &&
      managed.uri === reference.uri &&
      managed.workspaceFolderUri === reference.workspaceFolderUri
    );
  }

  additionalWorkspacePaths(
    references: readonly ChatReference[],
  ): readonly string[] {
    return references.some(
      (reference) =>
        reference.source === "attachment" && this.isManaged(reference),
    )
      ? [this.root.fsPath]
      : [];
  }

  dispose(): void {
    for (const uri of this.created) {
      void Promise.resolve(
        vscode.workspace.fs.delete(vscode.Uri.parse(uri)),
      ).catch(() => {
        // Best-effort removal of extension-owned temporary attachments.
      });
    }
    this.created.clear();
    this.managed.clear();
  }

  private async copyFile(source: vscode.Uri): Promise<ChatReference> {
    const stat = await vscode.workspace.fs.stat(source);
    if (stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `${basename(source.fsPath)} must be between 1 byte and 25 MB.`,
      );
    }
    const bytes = await vscode.workspace.fs.readFile(source);
    const displayName = normalizeDisplayName(
      basename(source.fsPath),
      "attachment",
    );
    return this.writeManagedFile(bytes, displayName, extname(displayName));
  }

  private async writeManagedFile(
    bytes: Uint8Array,
    displayName: string,
    extension: string,
  ): Promise<ChatReference> {
    await vscode.workspace.fs.createDirectory(this.root);
    const fileName = `${randomUUID()}${sanitizeExtension(extension)}`;
    const uri = vscode.Uri.joinPath(this.root, fileName);
    await vscode.workspace.fs.writeFile(uri, bytes);
    const reference: ChatReference = {
      id: uri.toString(),
      kind: "file",
      workspaceFolderUri: this.root.toString(),
      uri: uri.toString(),
      relativePath: fileName,
      displayName,
      source: "attachment",
    };
    this.created.add(uri.toString());
    this.managed.set(reference.id, reference);
    return reference;
  }
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new Error("The clipboard image payload is invalid.");
  }
  return Buffer.from(normalized, "base64");
}

function normalizeDisplayName(value: string, fallback: string): string {
  const name = basename(value.trim());
  return name.length === 0 ? fallback : name.slice(0, 180);
}

function sanitizeExtension(value: string): string {
  return /^\.[A-Za-z0-9]{1,10}$/u.test(value) ? value.toLowerCase() : "";
}
