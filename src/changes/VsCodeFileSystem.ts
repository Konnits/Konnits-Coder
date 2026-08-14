import * as path from "node:path";
import * as vscode from "vscode";
import type { FileSystemPort } from "./ProposedFileChange.js";

export class VsCodeFileSystem implements FileSystemPort {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly encoder = new TextEncoder();

  readText = async (uriValue: string): Promise<string | null> => {
    const uri = vscode.Uri.parse(uriValue, true);
    try {
      return this.decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw new Error(`Unable to read ${uri.fsPath}.`, { cause: error });
    }
  };

  writeText = async (uriValue: string, content: string): Promise<void> => {
    const uri = vscode.Uri.parse(uriValue, true);
    await vscode.workspace.fs.createDirectory(
      uri.with({ path: path.posix.dirname(uri.path) }),
    );
    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(content));
  };

  deleteFile = async (uriValue: string): Promise<void> => {
    const uri = vscode.Uri.parse(uriValue, true);
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  };

  isDirty = (uriValue: string): boolean => {
    const target = vscode.Uri.parse(uriValue, true).toString();
    return vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === target && document.isDirty,
    );
  };

  resolveWorkspaceTarget(rawPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      throw new Error("Open a workspace folder before allowing file edits.");
    }

    const firstFolder = folders[0];
    if (firstFolder === undefined) {
      throw new Error("Open a workspace folder before allowing file edits.");
    }
    const candidate = path.resolve(firstFolder.uri.fsPath, rawPath);
    for (const folder of folders) {
      const relative = path.relative(folder.uri.fsPath, candidate);
      if (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      ) {
        const segments = relative
          .split(path.sep)
          .filter((segment) => segment.length > 0);
        return vscode.Uri.joinPath(folder.uri, ...segments);
      }
    }
    throw new Error(
      `The requested file is outside the open workspace: ${rawPath}`,
    );
  }

  displayPath(uriValue: string): string {
    const uri = vscode.Uri.parse(uriValue, true);
    return vscode.workspace.asRelativePath(uri, false);
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    (error.code === "FileNotFound" || error.code === "EntryNotFound")
  );
}
