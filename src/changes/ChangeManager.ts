import { randomUUID } from "node:crypto";
import {
  contentMatches,
  countChangedLines,
  hashContent,
} from "./ChangeConflictDetector.js";
import type {
  FileSystemPort,
  ProposedFileChange,
} from "./ProposedFileChange.js";

interface ActiveSnapshot {
  readonly uri: string;
  readonly before: string | null;
  readonly existingChangeId?: string;
}

export class ChangeManager {
  private readonly changes = new Map<string, ProposedFileChange>();
  private readonly active = new Map<string, ActiveSnapshot>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fileSystem: FileSystemPort) {}

  list(): readonly ProposedFileChange[] {
    return [...this.changes.values()].sort(
      (left, right) => left.createdAt - right.createdAt,
    );
  }

  get(id: string): ProposedFileChange | undefined {
    return this.changes.get(id);
  }

  async begin(uri: string): Promise<void> {
    if (this.active.has(uri)) {
      return;
    }

    const current = await this.fileSystem.readText(uri);
    const pending = this.findPending(uri);
    if (pending !== undefined) {
      if (
        this.fileSystem.isDirty(uri) ||
        !contentMatches(current, pending.proposedHash)
      ) {
        this.markConflict(
          pending.id,
          "The file changed independently before the next agent edit.",
        );
        throw new Error(`Cannot safely track another edit for ${uri}.`);
      }
      this.active.set(uri, {
        uri,
        before: current,
        existingChangeId: pending.id,
      });
      return;
    }

    this.active.set(uri, { uri, before: current });
  }

  async complete(uri: string): Promise<ProposedFileChange | undefined> {
    const snapshot = this.active.get(uri);
    if (snapshot === undefined) {
      return undefined;
    }
    this.active.delete(uri);
    const after = await this.fileSystem.readText(uri);

    if (snapshot.existingChangeId !== undefined) {
      const existing = this.changes.get(snapshot.existingChangeId);
      if (existing?.status !== "pending") {
        return undefined;
      }
      if (snapshot.before === after) {
        return existing;
      }
      const counts = countChangedLines(existing.originalContent, after);
      const updated: ProposedFileChange = {
        ...existing,
        proposedContent: after,
        proposedHash: hashContent(after),
        additions: counts.additions,
        deletions: counts.deletions,
        updatedAt: Date.now(),
      };
      this.changes.set(updated.id, updated);
      this.emitChange();
      return updated;
    }

    if (snapshot.before === after) {
      return undefined;
    }

    const counts = countChangedLines(snapshot.before, after);
    const now = Date.now();
    const change: ProposedFileChange = {
      id: randomUUID(),
      uri,
      originalContent: snapshot.before,
      proposedContent: after,
      originalHash: hashContent(snapshot.before),
      proposedHash: hashContent(after),
      status: "pending",
      additions: counts.additions,
      deletions: counts.deletions,
      createdAt: now,
      updatedAt: now,
    };
    this.changes.set(change.id, change);
    this.emitChange();
    return change;
  }

  async completeAll(): Promise<void> {
    for (const uri of [...this.active.keys()]) {
      await this.complete(uri);
    }
  }

  async accept(id: string): Promise<ProposedFileChange> {
    const change = this.requirePending(id);
    await this.assertLiveProposal(change);
    return this.updateStatus(change, "accepted");
  }

  async reject(id: string): Promise<ProposedFileChange> {
    const change = this.requirePending(id);
    await this.assertLiveProposal(change);

    if (change.originalContent === null) {
      await this.fileSystem.deleteFile(change.uri);
    } else {
      await this.fileSystem.writeText(change.uri, change.originalContent);
    }

    const restored = await this.fileSystem.readText(change.uri);
    if (!contentMatches(restored, change.originalHash)) {
      return this.markConflict(
        change.id,
        "The original content could not be verified after restoration.",
      );
    }
    return this.updateStatus(change, "rejected");
  }

  async acceptAll(): Promise<readonly ProposedFileChange[]> {
    return this.applyAll((id) => this.accept(id));
  }

  async rejectAll(): Promise<readonly ProposedFileChange[]> {
    return this.applyAll((id) => this.reject(id));
  }

  clearSettled(): void {
    for (const [id, change] of this.changes) {
      if (change.status !== "pending" && change.status !== "conflicted") {
        this.changes.delete(id);
      }
    }
    this.emitChange();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async assertLiveProposal(change: ProposedFileChange): Promise<void> {
    if (this.fileSystem.isDirty(change.uri)) {
      this.markConflict(
        change.id,
        "The file has unsaved editor changes. Save or reconcile it before review actions.",
      );
      throw new Error("Refusing to overwrite an editor with unsaved changes.");
    }
    const current = await this.fileSystem.readText(change.uri);
    if (!contentMatches(current, change.proposedHash)) {
      this.markConflict(
        change.id,
        "The file no longer matches the agent proposal and was not overwritten.",
      );
      throw new Error("The file changed after the agent proposal.");
    }
  }

  private requirePending(id: string): ProposedFileChange {
    const change = this.changes.get(id);
    if (change === undefined) {
      throw new Error(`Unknown file change: ${id}`);
    }
    if (change.status !== "pending") {
      throw new Error(`File change ${id} is ${change.status}, not pending.`);
    }
    return change;
  }

  private findPending(uri: string): ProposedFileChange | undefined {
    return [...this.changes.values()].find(
      (change) => change.uri === uri && change.status === "pending",
    );
  }

  private updateStatus(
    change: ProposedFileChange,
    status: "accepted" | "rejected",
  ): ProposedFileChange {
    const updated: ProposedFileChange = {
      ...change,
      status,
      updatedAt: Date.now(),
    };
    this.changes.set(change.id, updated);
    this.emitChange();
    return updated;
  }

  private markConflict(id: string, reason: string): ProposedFileChange {
    const change = this.changes.get(id);
    if (change === undefined) {
      throw new Error(`Unknown file change: ${id}`);
    }
    const conflicted: ProposedFileChange = {
      ...change,
      status: "conflicted",
      conflictReason: reason,
      updatedAt: Date.now(),
    };
    this.changes.set(id, conflicted);
    this.emitChange();
    return conflicted;
  }

  private async applyAll(
    action: (id: string) => Promise<ProposedFileChange>,
  ): Promise<readonly ProposedFileChange[]> {
    const results: ProposedFileChange[] = [];
    const pending = this.list().filter((change) => change.status === "pending");
    for (const change of pending) {
      try {
        results.push(await action(change.id));
      } catch {
        const result = this.changes.get(change.id);
        if (result !== undefined) {
          results.push(result);
        }
      }
    }
    return results;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
