import { describe, expect, it } from "vitest";
import { ChangeManager } from "../../src/changes/ChangeManager.js";
import type { FileSystemPort } from "../../src/changes/ProposedFileChange.js";

class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly dirty = new Set<string>();

  async readText(uri: string): Promise<string | null> {
    return this.files.get(uri) ?? null;
  }

  async writeText(uri: string, content: string): Promise<void> {
    this.files.set(uri, content);
  }

  async deleteFile(uri: string): Promise<void> {
    this.files.delete(uri);
  }

  isDirty(uri: string): boolean {
    return this.dirty.has(uri);
  }
}

describe("ChangeManager", () => {
  it("captures and accepts an already-applied edit", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "before\n");
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "after\n");
    const proposed = await manager.complete("file:///a.ts");
    const accepted = await manager.accept(proposed!.id);

    expect(accepted.status).toBe("accepted");
    expect(fileSystem.files.get("file:///a.ts")).toBe("after\n");
  });

  it("rejects an edit by restoring the exact original content", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "before\n");
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "after\n");
    const proposed = await manager.complete("file:///a.ts");
    const rejected = await manager.reject(proposed!.id);

    expect(rejected.status).toBe("rejected");
    expect(fileSystem.files.get("file:///a.ts")).toBe("before\n");
  });

  it("rejects an agent-created file by deleting only the captured result", async () => {
    const fileSystem = new MemoryFileSystem();
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///new.ts");
    fileSystem.files.set("file:///new.ts", "created\n");
    const proposed = await manager.complete("file:///new.ts");
    await manager.reject(proposed!.id);

    expect(fileSystem.files.has("file:///new.ts")).toBe(false);
  });

  it("restores an agent-deleted file", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///old.ts", "original\n");
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///old.ts");
    fileSystem.files.delete("file:///old.ts");
    const proposed = await manager.complete("file:///old.ts");
    await manager.reject(proposed!.id);

    expect(fileSystem.files.get("file:///old.ts")).toBe("original\n");
  });

  it("preserves the session base across multiple agent edits", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "base");
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "first");
    const first = await manager.complete("file:///a.ts");
    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "second");
    const second = await manager.complete("file:///a.ts");
    await manager.reject(second!.id);

    expect(second!.id).toBe(first!.id);
    expect(fileSystem.files.get("file:///a.ts")).toBe("base");
  });

  it("marks a conflict and refuses to overwrite a manual change", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "base");
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "agent");
    const proposed = await manager.complete("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "manual");

    await expect(manager.reject(proposed!.id)).rejects.toThrow(
      "changed after the agent proposal",
    );
    expect(manager.get(proposed!.id)?.status).toBe("conflicted");
    expect(fileSystem.files.get("file:///a.ts")).toBe("manual");
  });

  it("refuses to act on a dirty editor", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "base");
    const manager = new ChangeManager(fileSystem);

    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "agent");
    const proposed = await manager.complete("file:///a.ts");
    fileSystem.dirty.add("file:///a.ts");

    await expect(manager.accept(proposed!.id)).rejects.toThrow(
      "unsaved changes",
    );
    expect(manager.get(proposed!.id)?.status).toBe("conflicted");
  });

  it("reject-all restores safe files while preserving conflicted files", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "a0");
    fileSystem.files.set("file:///b.ts", "b0");
    const manager = new ChangeManager(fileSystem);
    await manager.begin("file:///a.ts");
    await manager.begin("file:///b.ts");
    fileSystem.files.set("file:///a.ts", "a1");
    fileSystem.files.set("file:///b.ts", "b1");
    await manager.completeAll();
    fileSystem.files.set("file:///b.ts", "manual");

    await manager.rejectAll();

    expect(fileSystem.files.get("file:///a.ts")).toBe("a0");
    expect(fileSystem.files.get("file:///b.ts")).toBe("manual");
    expect(
      manager
        .list()
        .map((change) => change.status)
        .sort(),
    ).toEqual(["conflicted", "rejected"]);
  });

  it("restores every tracked file to its state before a prompt", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "base");
    const manager = new ChangeManager(fileSystem);
    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "first turn");
    await manager.complete("file:///a.ts");
    await manager.captureCheckpoint("prompt-2");

    await manager.begin("file:///a.ts");
    await manager.begin("file:///new.ts");
    fileSystem.files.set("file:///a.ts", "second turn");
    fileSystem.files.set("file:///new.ts", "created later");
    await manager.completeAll();

    expect(manager.hasChangesSinceCheckpoint("prompt-2")).toBe(true);
    await manager.restoreCheckpoint("prompt-2");

    expect(fileSystem.files.get("file:///a.ts")).toBe("first turn");
    expect(fileSystem.files.has("file:///new.ts")).toBe(false);
    expect(manager.list()).toHaveLength(1);
    expect(manager.hasChangesSinceCheckpoint("prompt-2")).toBe(false);
  });

  it("refuses checkpoint restoration when a tracked file changed manually", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "base");
    const manager = new ChangeManager(fileSystem);
    await manager.captureCheckpoint("prompt-1");
    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "agent");
    await manager.complete("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "manual");

    await expect(manager.restoreCheckpoint("prompt-1")).rejects.toThrow(
      "independent changes",
    );
    expect(fileSystem.files.get("file:///a.ts")).toBe("manual");
    expect(manager.list()[0]?.status).toBe("conflicted");
  });

  it("restores checkpoint metadata after an accepted later change", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("file:///a.ts", "base");
    const manager = new ChangeManager(fileSystem);
    await manager.captureCheckpoint("prompt-1");
    await manager.begin("file:///a.ts");
    fileSystem.files.set("file:///a.ts", "accepted agent change");
    const change = await manager.complete("file:///a.ts");
    await manager.accept(change!.id);

    await manager.restoreCheckpoint("prompt-1");

    expect(fileSystem.files.get("file:///a.ts")).toBe("base");
    expect(manager.list()).toEqual([]);
  });

  it("does not overwrite an independently recreated file when moving forward to a checkpoint", async () => {
    const fileSystem = new MemoryFileSystem();
    const manager = new ChangeManager(fileSystem);
    await manager.captureCheckpoint("before-create");
    await manager.begin("file:///new.ts");
    fileSystem.files.set("file:///new.ts", "agent-created");
    await manager.complete("file:///new.ts");
    await manager.captureCheckpoint("after-create");
    await manager.restoreCheckpoint("before-create");
    fileSystem.files.set("file:///new.ts", "independent-user-file");

    await expect(manager.restoreCheckpoint("after-create")).rejects.toThrow(
      "independent changes",
    );
    expect(fileSystem.files.get("file:///new.ts")).toBe(
      "independent-user-file",
    );
  });
});
