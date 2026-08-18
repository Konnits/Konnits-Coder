import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  workspaceFolders: [] as { readonly uri: { readonly fsPath: string } }[],
  createDirectory: vi.fn(async () => undefined),
  updateWorkspaceFolders: vi.fn(() => true),
  showWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => {
  class Uri {
    static file(fsPath: string): Uri {
      return new Uri(fsPath);
    }

    static parse(value: string): Uri {
      return new Uri(value.replace(/^file:\/\/\//u, ""));
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(path.join(base.fsPath, ...segments));
    }

    readonly scheme = "file";
    readonly path: string;

    constructor(readonly fsPath: string) {
      this.path = fsPath.replaceAll("\\", "/");
    }

    toString(): string {
      return `file:///${this.path}`;
    }

    with(change: { readonly path?: string }): Uri {
      return new Uri(change.path ?? this.fsPath);
    }
  }

  return {
    Uri,
    FileSystemError: class FileSystemError extends Error {},
    workspace: {
      get workspaceFolders() {
        return vscodeMock.workspaceFolders;
      },
      fs: {
        createDirectory: vscodeMock.createDirectory,
        readFile: vi.fn(),
        writeFile: vi.fn(),
        delete: vi.fn(),
      },
      textDocuments: [],
      asRelativePath: (uri: Uri) => uri.fsPath,
      updateWorkspaceFolders: vscodeMock.updateWorkspaceFolders,
    },
    window: {
      showWarningMessage: vscodeMock.showWarningMessage,
    },
  };
});

import { VsCodeFileSystem } from "../../src/changes/VsCodeFileSystem.js";

describe("VsCodeFileSystem workspace target resolution", () => {
  beforeEach(() => {
    vscodeMock.workspaceFolders = [{ uri: { fsPath: "C:\\workspace" } }];
    vscodeMock.createDirectory.mockReset();
    vscodeMock.createDirectory.mockResolvedValue(undefined);
    vscodeMock.updateWorkspaceFolders.mockReset();
    vscodeMock.updateWorkspaceFolders.mockReturnValue(true);
    vscodeMock.showWarningMessage.mockReset();
  });

  it("resolves workspace files without requesting another folder", async () => {
    const fileSystem = new VsCodeFileSystem();

    const uri = await fileSystem.resolveOrRequestWorkspaceTarget(
      "C:\\workspace\\src\\app.ts",
    );

    expect(uri.fsPath).toBe("C:\\workspace\\src\\app.ts");
    expect(vscodeMock.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeMock.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it("does not authorize or create an external folder when the user declines", async () => {
    vscodeMock.showWarningMessage.mockResolvedValue(undefined);
    const fileSystem = new VsCodeFileSystem();

    await expect(
      fileSystem.resolveOrRequestWorkspaceTarget(
        "C:\\Users\\geral\\.ensemble-agent\\config.toml",
      ),
    ).rejects.toThrow("The user declined to add the external folder");
    expect(vscodeMock.createDirectory).not.toHaveBeenCalled();
    expect(vscodeMock.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it("adds only the external file parent and resolves it once VS Code reports the folder", async () => {
    vscodeMock.showWarningMessage.mockResolvedValue("Add Folder to Workspace");
    const fileSystem = new VsCodeFileSystem();
    const target = "C:\\Users\\geral\\.ensemble-agent\\config.toml";

    const uri = await fileSystem.resolveOrRequestWorkspaceTarget(target);

    expect(uri.fsPath).toBe(target);
    expect(vscodeMock.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: "C:\\Users\\geral\\.ensemble-agent",
      }),
    );
    const updateCall = vscodeMock.updateWorkspaceFolders.mock
      .calls[0] as unknown as [
      number,
      null,
      { readonly uri: { readonly fsPath: string } },
    ];
    expect(updateCall[0]).toBe(1);
    expect(updateCall[1]).toBeNull();
    expect(updateCall[2].uri.fsPath).toBe("C:\\Users\\geral\\.ensemble-agent");
    vscodeMock.workspaceFolders.push({ uri: updateCall[2].uri });
    expect(fileSystem.resolveWorkspaceTarget(target).fsPath).toBe(target);
    vscodeMock.workspaceFolders.pop();
    expect(() => fileSystem.resolveWorkspaceTarget(target)).toThrow(
      "outside the open workspace",
    );
  });

  it("does not retain authorization when VS Code rejects the folder update", async () => {
    vscodeMock.showWarningMessage.mockResolvedValue("Add Folder to Workspace");
    vscodeMock.updateWorkspaceFolders.mockReturnValue(false);
    const fileSystem = new VsCodeFileSystem();
    const target = "C:\\Users\\geral\\.ensemble-agent\\config.toml";

    await expect(
      fileSystem.resolveOrRequestWorkspaceTarget(target),
    ).rejects.toThrow("VS Code could not add the external folder");
    expect(() => fileSystem.resolveWorkspaceTarget(target)).toThrow(
      "outside the open workspace",
    );
  });

  it("does not request a workspace update when the external folder cannot be created", async () => {
    vscodeMock.showWarningMessage.mockResolvedValue("Add Folder to Workspace");
    vscodeMock.createDirectory.mockRejectedValue(new Error("Access denied"));
    const fileSystem = new VsCodeFileSystem();

    await expect(
      fileSystem.resolveOrRequestWorkspaceTarget(
        "C:\\Users\\geral\\.ensemble-agent\\config.toml",
      ),
    ).rejects.toThrow("Access denied");
    expect(vscodeMock.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it("refuses to add an entire filesystem root", async () => {
    const fileSystem = new VsCodeFileSystem();

    await expect(
      fileSystem.resolveOrRequestWorkspaceTarget("C:\\config.toml"),
    ).rejects.toThrow("Refusing to add a filesystem root");
    expect(vscodeMock.showWarningMessage).not.toHaveBeenCalled();
  });
});
