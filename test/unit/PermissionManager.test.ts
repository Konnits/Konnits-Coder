import { describe, expect, it } from "vitest";
import { PermissionManager } from "../../src/permissions/PermissionManager.js";

describe("PermissionManager", () => {
  it("resolves an explicit allow decision", async () => {
    const manager = new PermissionManager();
    const controller = new AbortController();
    const pending = manager.request(
      {
        id: "p1",
        toolName: "edit",
        title: "Allow edit?",
        risk: "write",
        input: {},
      },
      controller.signal,
    );

    expect(manager.list()).toHaveLength(1);
    expect(manager.resolve("p1", "allow")).toBe(true);
    await expect(pending).resolves.toBe("allow");
    expect(manager.list()).toHaveLength(0);
  });

  it("fails closed when aborted before or during a request", async () => {
    const first = new PermissionManager();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      first.request(
        {
          id: "p1",
          toolName: "edit",
          title: "Allow edit?",
          risk: "write",
          input: {},
        },
        alreadyAborted.signal,
      ),
    ).resolves.toBe("deny");

    const second = new PermissionManager();
    const controller = new AbortController();
    const pending = second.request(
      {
        id: "p2",
        toolName: "edit",
        title: "Allow edit?",
        risk: "write",
        input: {},
      },
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toBe("deny");
  });
});
