import { createHash } from "node:crypto";

export function hashContent(content: string | null): string | null {
  return content === null
    ? null
    : createHash("sha256").update(content, "utf8").digest("hex");
}

export function contentMatches(
  current: string | null,
  expectedHash: string | null,
): boolean {
  return hashContent(current) === expectedHash;
}

export function countChangedLines(
  original: string | null,
  proposed: string | null,
): { additions: number; deletions: number } {
  const before = original?.split(/\r?\n/u) ?? [];
  const after = proposed?.split(/\r?\n/u) ?? [];
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    additions: Math.max(0, after.length - prefix - suffix),
    deletions: Math.max(0, before.length - prefix - suffix),
  };
}
