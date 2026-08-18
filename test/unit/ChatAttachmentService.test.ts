import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  showOpenDialog: vi.fn(),
  createDirectory: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => {
  class FakeUri {
    constructor(readonly fsPath: string) {}
    toString(): string {
      return `file:///${this.fsPath.replaceAll("\\", "/")}`;
    }
  }
  return {
    Uri: {
      file: (value: string) => new FakeUri(value),
      parse: (value: string) => new FakeUri(value.replace(/^file:\/\/\//u, "")),
      joinPath: (root: FakeUri, ...parts: string[]) =>
        new FakeUri([root.fsPath, ...parts].join("/")),
    },
    window: { showOpenDialog: mocks.showOpenDialog },
    workspace: {
      fs: {
        createDirectory: mocks.createDirectory,
        delete: mocks.delete,
        readFile: vi.fn(async (uri: FakeUri) => {
          const value = mocks.files.get(uri.fsPath);
          if (value === undefined) throw new Error("missing");
          return value;
        }),
        stat: vi.fn(async (uri: FakeUri) => ({
          size: mocks.files.get(uri.fsPath)?.byteLength ?? 0,
        })),
        writeFile: vi.fn(async (uri: FakeUri, value: Uint8Array) => {
          mocks.files.set(uri.fsPath, value);
        }),
      },
    },
  };
});

describe("ChatAttachmentService", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  it("stores clipboard images in its isolated managed directory", async () => {
    const vscode = await import("vscode");
    const { ChatAttachmentService } =
      await import("../../src/chat/ChatAttachmentService.js");
    const service = new ChatAttachmentService(
      vscode.Uri.file("C:/extension-storage/attachments"),
    );

    const reference = await service.saveClipboardImage({
      name: "capture.png",
      mimeType: "image/png",
      data: "AAEC/w==",
    });

    expect(reference).toMatchObject({
      kind: "file",
      displayName: "capture.png",
      source: "attachment",
    });
    expect(service.isManaged(reference)).toBe(true);
    expect(service.additionalWorkspacePaths([reference])).toEqual([
      "C:/extension-storage/attachments",
    ]);
    expect(Array.from([...mocks.files.values()][0] ?? [])).toEqual([
      0, 1, 2, 255,
    ]);
  });

  it("copies files selected through the native picker", async () => {
    const vscode = await import("vscode");
    const { ChatAttachmentService } =
      await import("../../src/chat/ChatAttachmentService.js");
    const source = vscode.Uri.file("C:/outside/report.pdf");
    mocks.files.set(source.fsPath, Uint8Array.from([1, 2, 3]));
    mocks.showOpenDialog.mockResolvedValueOnce([source]);
    const service = new ChatAttachmentService(
      vscode.Uri.file("C:/extension-storage/attachments"),
    );

    const references = await service.pickFiles();

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      displayName: "report.pdf",
      source: "attachment",
    });
    expect(mocks.createDirectory).toHaveBeenCalledOnce();
  });

  it("rejects malformed clipboard payloads", async () => {
    const vscode = await import("vscode");
    const { ChatAttachmentService } =
      await import("../../src/chat/ChatAttachmentService.js");
    const service = new ChatAttachmentService(
      vscode.Uri.file("C:/extension-storage/attachments"),
    );

    await expect(
      service.saveClipboardImage({
        name: "capture.png",
        mimeType: "image/png",
        data: "not-base64",
      }),
    ).rejects.toThrow("invalid");
  });

  it("rejects unsupported clipboard image types", async () => {
    const vscode = await import("vscode");
    const { ChatAttachmentService } =
      await import("../../src/chat/ChatAttachmentService.js");
    const service = new ChatAttachmentService(
      vscode.Uri.file("C:/extension-storage/attachments"),
    );

    await expect(
      service.saveClipboardImage({
        name: "capture.svg",
        mimeType: "image/svg+xml",
        data: "PHN2Zy8+",
      }),
    ).rejects.toThrow("Unsupported clipboard image type");
  });
});
