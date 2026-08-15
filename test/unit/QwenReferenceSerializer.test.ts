import { describe, expect, it } from "vitest";
import {
  escapeQwenPath,
  serializeQwenPrompt,
  serializeQwenReference,
} from "../../src/qwen/QwenReferenceSerializer.js";
import type { ChatReference } from "../../src/webview/messages.js";

const primaryFolder = "file:///C:/workspace";

function reference(
  relativePath: string,
  kind: ChatReference["kind"] = "file",
  workspaceFolderUri = primaryFolder,
  uri = `${workspaceFolderUri}/${relativePath.replaceAll("\\", "/")}`,
): ChatReference {
  return {
    id: uri,
    kind,
    workspaceFolderUri,
    uri,
    relativePath,
    displayName: relativePath,
  };
}

describe("Qwen reference serialization", () => {
  it("keeps selected references separate from visible user text", () => {
    expect(
      serializeQwenPrompt("Analiza la arquitectura.", [
        reference("README.md"),
        reference("src/", "directory"),
      ]),
    ).toBe("@README.md @src/ Analiza la arquitectura.");
  });

  it("escapes spaces and special characters using Qwen path syntax", () => {
    expect(escapeQwenPath("My Documents/README;draft.md")).toBe(
      "My\\ Documents/README\\;draft.md",
    );
    expect(serializeQwenReference(reference("My Documents/README.md"))).toBe(
      "@My\\ Documents/README.md",
    );
  });

  it("normalizes Windows separators and supports directories", () => {
    expect(serializeQwenReference(reference("src\\extension.ts"))).toBe(
      "@src/extension.ts",
    );
    expect(serializeQwenReference(reference("src\\", "directory"))).toBe(
      "@src/",
    );
  });

  it("uses an absolute path only for a non-primary workspace root", () => {
    expect(
      serializeQwenReference(
        reference(
          "README.md",
          "file",
          "file:///D:/other",
          "file:///D:/other/README.md",
        ),
        { primaryWorkspaceFolderUri: primaryFolder },
      ),
    ).toBe("@D:/other/README.md");
  });

  it("rejects paths that escape the workspace root", () => {
    expect(() => serializeQwenReference(reference("../secret.txt"))).toThrow(
      "Invalid workspace-relative",
    );
  });
});
