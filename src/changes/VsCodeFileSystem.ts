import * as path from "node:path";
import * as vscode from "vscode";
import type { FileSystemPort } from "./ProposedFileChange.js";

const ALLOW_EXTERNAL_FILE_ACTION = "Allow This File Once";
const ADD_WORKSPACE_FOLDER_ACTION = "Add Parent Folder to Workspace";

class OutsideWorkspaceError extends Error {
  constructor(
    readonly rawPath: string,
    readonly candidatePath: string,
  ) {
    super(`The requested file is outside the open workspace: ${rawPath}`);
    this.name = "OutsideWorkspaceError";
  }
}

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
      const resolved = resolveWithinRoot(folder.uri, candidate);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    throw new OutsideWorkspaceError(rawPath, candidate);
  }

  async resolveOrRequestWorkspaceTarget(rawPath: string): Promise<vscode.Uri> {
    try {
      return this.resolveWorkspaceTarget(rawPath);
    } catch (error) {
      if (!(error instanceof OutsideWorkspaceError)) {
        throw error;
      }
      const folderPath = path.dirname(error.candidatePath);
      const canAddFolder = path.parse(folderPath).root !== folderPath;
      const actions = canAddFolder
        ? [ALLOW_EXTERNAL_FILE_ACTION, ADD_WORKSPACE_FOLDER_ACTION]
        : [ALLOW_EXTERNAL_FILE_ACTION];
      const selected = await vscode.window.showWarningMessage(
        `The requested file is outside the open workspace: ${error.rawPath}`,
        {
          modal: true,
          detail:
            "You can allow this exact file for the current edit without changing the workspace" +
            (canAddFolder
              ? ", or add its immediate parent folder to the workspace"
              : "") +
            `. Both choices retain Changed Files review.\n\nFile:\n${error.candidatePath}` +
            (canAddFolder
              ? `\n\nParent folder:\n${folderPath}\n\nThe folder will be created if needed. No broader parent folder will be added.`
              : ""),
        },
        ...actions,
      );
      if (selected === ALLOW_EXTERNAL_FILE_ACTION) {
        return vscode.Uri.file(error.candidatePath);
      }
      if (selected !== ADD_WORKSPACE_FOLDER_ACTION || !canAddFolder) {
        throw new Error(
          `The user declined external edit access for: ${error.candidatePath}`,
        );
      }

      const folderUri = vscode.Uri.file(folderPath);
      await vscode.workspace.fs.createDirectory(folderUri);
      const started = vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        null,
        { uri: folderUri },
      );
      if (!started) {
        throw new Error(
          `VS Code could not add the external folder to the workspace: ${folderPath}`,
        );
      }

      const resolved = resolveWithinRoot(folderUri, error.candidatePath);
      if (resolved === undefined) {
        throw new Error(
          `The external file is not contained by the approved folder: ${error.rawPath}`,
        );
      }
      return resolved;
    }
  }

  displayPath(uriValue: string): string {
    const uri = vscode.Uri.parse(uriValue, true);
    return vscode.workspace.asRelativePath(uri, false);
  }
}

function resolveWithinRoot(
  root: vscode.Uri,
  candidate: string,
): vscode.Uri | undefined {
  const relative = path.relative(root.fsPath, candidate);
  if (
    relative !== "" &&
    (relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative))
  ) {
    return undefined;
  }
  const segments = relative
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  return vscode.Uri.joinPath(root, ...segments);
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    (error.code === "FileNotFound" || error.code === "EntryNotFound")
  );
}
