import { dirname, relative } from "node:path";
import * as vscode from "vscode";
import type {
  ChatReference,
  WorkspaceReferenceSuggestion,
} from "../webview/messages.js";

const MAX_FILES_PER_FOLDER = 500;
const MAX_RESULTS = 40;
const EXCLUDE_GLOB =
  "**/{node_modules,.git,dist,build,out,.qwen/pending-skills}/**";
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".eot",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export interface WorkspaceReferenceSearchPort {
  readonly workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  readonly activeDocumentUri: vscode.Uri | undefined;
  findFiles(
    include: vscode.GlobPattern,
    exclude: vscode.GlobPattern,
    maxResults: number,
  ): Thenable<readonly vscode.Uri[]>;
}

export class WorkspaceReferenceService {
  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceReferenceSuggestion[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      return [];
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const candidates = new Map<string, Candidate>();

    for (const folder of folders) {
      if (signal?.aborted === true) {
        return [];
      }
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*"),
        EXCLUDE_GLOB,
        MAX_FILES_PER_FOLDER,
      );
      for (const uri of files) {
        if (isBinary(uri.fsPath)) {
          continue;
        }
        addCandidate(candidates, createFileReference(folder, uri));
        addDirectoryCandidates(candidates, folder, uri, activeUri);
      }
    }

    const duplicatePaths = duplicateRelativePaths(candidates.values());
    const scored: WorkspaceReferenceSuggestion[] = [];
    for (const candidate of candidates.values()) {
      const displayName = duplicatePaths.has(candidate.reference.relativePath)
        ? `${candidate.workspaceName}/${candidate.reference.relativePath}`
        : candidate.reference.relativePath;
      const displayReference = {
        ...candidate.reference,
        displayName,
        ...(duplicatePaths.has(candidate.reference.relativePath)
          ? { workspaceName: candidate.workspaceName }
          : {}),
      };
      const score = fuzzyPathScore(query, displayName);
      if (score === undefined) {
        continue;
      }
      scored.push({
        ...displayReference,
        score: score + candidate.activeBoost,
      });
    }
    return scored
      .sort((left, right) =>
        right.score === left.score
          ? left.displayName.localeCompare(right.displayName)
          : right.score - left.score,
      )
      .slice(0, MAX_RESULTS);
  }
}

interface Candidate {
  readonly reference: ChatReference;
  readonly workspaceName: string;
  readonly activeBoost: number;
}

function createFileReference(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
): Candidate {
  return {
    reference: {
      id: uri.toString(),
      kind: "file",
      workspaceFolderUri: folder.uri.toString(),
      uri: uri.toString(),
      relativePath: normalizeRelativePath(
        relative(folder.uri.fsPath, uri.fsPath),
      ),
      displayName: normalizeRelativePath(
        relative(folder.uri.fsPath, uri.fsPath),
      ),
    },
    workspaceName: folder.name,
    activeBoost: isActiveDocument(uri) ? 10_000 : 0,
  };
}

function addDirectoryCandidates(
  candidates: Map<string, Candidate>,
  folder: vscode.WorkspaceFolder,
  fileUri: vscode.Uri,
  activeUri: vscode.Uri | undefined,
): void {
  let current = dirname(fileUri.fsPath);
  const root = folder.uri.fsPath;
  while (isWithin(root, current) && current !== root) {
    const directoryUri = vscode.Uri.file(current);
    const relativePath = `${normalizeRelativePath(relative(root, current))}/`;
    addCandidate(candidates, {
      reference: {
        id: directoryUri.toString(),
        kind: "directory",
        workspaceFolderUri: folder.uri.toString(),
        uri: directoryUri.toString(),
        relativePath,
        displayName: relativePath,
      },
      workspaceName: folder.name,
      activeBoost:
        activeUri !== undefined && isWithin(current, activeUri.fsPath)
          ? 5_000
          : 0,
    });
    current = dirname(current);
  }
}

function addCandidate(
  candidates: Map<string, Candidate>,
  candidate: Candidate,
): void {
  const existing = candidates.get(candidate.reference.id);
  if (existing === undefined || candidate.activeBoost > existing.activeBoost) {
    candidates.set(candidate.reference.id, candidate);
  }
}

function duplicateRelativePaths(candidates: Iterable<Candidate>): Set<string> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(
      candidate.reference.relativePath,
      (counts.get(candidate.reference.relativePath) ?? 0) + 1,
    );
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([path]) => path),
  );
}

export function fuzzyPathScore(
  query: string,
  candidate: string,
): number | undefined {
  const normalizedQuery = query.replaceAll("\\", "/").trim().toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();
  if (normalizedQuery.length === 0) {
    return 1;
  }
  const exactIndex = normalizedCandidate.indexOf(normalizedQuery);
  if (exactIndex >= 0) {
    return 1_000 - exactIndex * 2 - normalizedCandidate.length / 1_000;
  }
  let queryIndex = 0;
  let score = 0;
  for (let index = 0; index < normalizedCandidate.length; index += 1) {
    if (normalizedCandidate[index] === normalizedQuery[queryIndex]) {
      score +=
        index === 0 || "/_- .".includes(normalizedCandidate[index - 1] ?? "")
          ? 8
          : 2;
      queryIndex += 1;
      if (queryIndex === normalizedQuery.length) {
        return 500 + score - normalizedCandidate.length / 1_000;
      }
    }
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isWithin(root: string, value: string): boolean {
  const normalizedRoot = normalizeForComparison(root).replace(/\/$/u, "");
  const normalizedValue = normalizeForComparison(value).replace(/\/$/u, "");
  return (
    normalizedValue === normalizedRoot ||
    normalizedValue.startsWith(`${normalizedRoot}/`)
  );
}

function normalizeForComparison(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return /^[A-Za-z]:/u.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isBinary(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 && BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

function isActiveDocument(uri: vscode.Uri): boolean {
  return (
    vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()
  );
}
