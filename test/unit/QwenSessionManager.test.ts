import { describe, expect, it } from "vitest";
import { QwenSessionManager } from "../../src/qwen/QwenSessionManager.js";

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  readonly keys = (): readonly string[] => [...this.values.keys()];

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe("QwenSessionManager", () => {
  it("does not resume a workspace-scoped session until Qwen established it", async () => {
    const state = new MemoryMemento();
    const firstManager = new QwenSessionManager(state, "workspace-a");
    const first = await firstManager.getOrCreate();
    const beforeEstablished = await firstManager.getOrCreate();
    await firstManager.markEstablished(first.session.id);
    const secondManager = new QwenSessionManager(state, "workspace-a");
    const second = await secondManager.getOrCreate();

    expect(first.resume).toBe(false);
    expect(beforeEstablished.resume).toBe(false);
    expect(second.resume).toBe(true);
    expect(second.session.id).toBe(first.session.id);
  });

  it("resumes legacy stored sessions and lets the client verify them", async () => {
    const state = new MemoryMemento();
    await state.update("qwenFrontend.session.workspace-a", {
      id: "legacy-session",
      workspaceKey: "workspace-a",
      createdAt: 1,
    });

    const selection = await new QwenSessionManager(
      state,
      "workspace-a",
    ).getOrCreate();

    expect(selection.resume).toBe(true);
  });

  it("does not reuse a session from another workspace", async () => {
    const state = new MemoryMemento();
    const first = await new QwenSessionManager(
      state,
      "workspace-a",
    ).getOrCreate();
    const second = await new QwenSessionManager(
      state,
      "workspace-b",
    ).getOrCreate();

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.resume).toBe(false);
  });
});
