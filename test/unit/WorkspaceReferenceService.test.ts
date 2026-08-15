import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceReferenceService } from "../../src/chat/WorkspaceReferenceService.js";

const vscodeMock = vi.hoisted(() => ({
  activeTextEditor: undefined as unknown,
  findFiles: vi.fn(),
  workspaceFolders: [] as unknown[],
}));

vi.mock("vscode", () => ({
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
  Uri: {
    file: (fsPath: string) => createUri(fsPath),
  },
  window: {
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
  workspace: {
    findFiles: vscodeMock.findFiles,
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
  },
}));

describe("WorkspaceReferenceService", () => {
  beforeEach(() => {
    vscodeMock.activeTextEditor = undefined;
    vscodeMock.findFiles.mockReset();
    vscodeMock.workspaceFolders = [];
  });

  it("returns bounded fuzzy file/directory results with active and multi-root behavior", async () => {
    const application = workspaceFolder("app", "C:\\workspace\\app");
    const documentation = workspaceFolder("docs", "C:\\workspace\\docs");
    const activeFile = createUri("C:\\workspace\\app\\src\\QwenCode.ts");
    vscodeMock.workspaceFolders = [application, documentation];
    vscodeMock.activeTextEditor = { document: { uri: activeFile } };
    const allFiles = [
      createUri("C:\\workspace\\app\\package.json"),
      activeFile,
      createUri("C:\\workspace\\app\\src\\image.png"),
      createUri("C:\\workspace\\docs\\package.json"),
    ];
    vscodeMock.findFiles.mockImplementation(
      async (pattern: {
        readonly base: { readonly uri: { readonly fsPath: string } };
      }) =>
        allFiles.filter((file) =>
          file.fsPath.startsWith(`${pattern.base.uri.fsPath}\\`),
        ),
    );

    const results = await new WorkspaceReferenceService().search("Qwen");

    expect(results[0]).toMatchObject({
      kind: "file",
      relativePath: "src/QwenCode.ts",
      displayName: "src/QwenCode.ts",
    });
    expect(
      results.some((result) => result.relativePath.endsWith("image.png")),
    ).toBe(false);

    const service = new WorkspaceReferenceService();
    const directoryResults = await service.search("src");
    expect(directoryResults.some((result) => result.kind === "directory")).toBe(
      true,
    );
    expect(
      directoryResults.some((result) => result.relativePath === "src/"),
    ).toBe(true);

    const packageResults = await service.search("package");
    expect(packageResults.map((result) => result.displayName)).toEqual([
      "app/package.json",
      "docs/package.json",
    ]);
    expect(vscodeMock.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "**/*" }),
      expect.stringContaining("node_modules"),
      500,
    );
  });
});

function workspaceFolder(
  name: string,
  fsPath: string,
): {
  readonly name: string;
  readonly uri: ReturnType<typeof createUri>;
} {
  return { name, uri: createUri(fsPath) };
}

function createUri(fsPath: string): {
  readonly fsPath: string;
  toString(): string;
} {
  return {
    fsPath,
    toString: () => `file:///${fsPath.replaceAll("\\", "/")}`,
  };
}
