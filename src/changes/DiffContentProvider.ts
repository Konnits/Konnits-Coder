import * as path from "node:path";
import * as vscode from "vscode";
import type { ChangeManager } from "./ChangeManager.js";
import type { ProposedFileChange } from "./ProposedFileChange.js";

type DiffSide = "original" | "proposed";

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "qwen-review";

  constructor(private readonly changes: ChangeManager) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseReviewUri(uri);
    const change = this.changes.get(parsed.id);
    if (change === undefined) {
      throw new Error(
        `Qwen review content is no longer available for ${parsed.id}.`,
      );
    }
    return parsed.side === "original"
      ? (change.originalContent ?? "")
      : (change.proposedContent ?? "");
  }

  async review(change: ProposedFileChange, label: string): Promise<void> {
    const original = createReviewUri(change, "original");
    const proposed = createReviewUri(change, "proposed");
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      proposed,
      `${label} (Qwen: original ↔ proposed)`,
      { preview: true },
    );
  }
}

function createReviewUri(
  change: ProposedFileChange,
  side: DiffSide,
): vscode.Uri {
  const extension = path.extname(vscode.Uri.parse(change.uri, true).path);
  return vscode.Uri.from({
    scheme: DiffContentProvider.scheme,
    path: `/${side}/${change.id}/review${extension}`,
  });
}

function parseReviewUri(uri: vscode.Uri): { side: DiffSide; id: string } {
  const parts = uri.path.split("/").filter((part) => part.length > 0);
  const side = parts[0];
  const id = parts[1];
  if ((side !== "original" && side !== "proposed") || id === undefined) {
    throw new Error(`Invalid Qwen review URI: ${uri.toString()}`);
  }
  return { side, id };
}
