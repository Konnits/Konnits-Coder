import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ChangeManager } from "../../src/changes/ChangeManager.js";
import { ChangeTrackingService } from "../../src/changes/ChangeTrackingService.js";

describe("ChangeTrackingService", () => {
  it("requests workspace inclusion before capturing an edit snapshot", async () => {
    const begin = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const resolvedUri = {
      toString: (): string =>
        "file:///C:/Users/geral/.ensemble-agent/config.toml",
    } as vscode.Uri;
    const resolveOrRequestWorkspaceTarget = vi.fn(
      async (): Promise<vscode.Uri> => resolvedUri,
    );
    const service = new ChangeTrackingService(
      {
        begin,
        complete,
        completeAll: vi.fn(),
      } as unknown as ChangeManager,
      {
        resolveOrRequestWorkspaceTarget,
        resolveWorkspaceTarget: vi.fn(),
      },
    );

    await service.beforeEdit("C:\\Users\\geral\\.ensemble-agent\\config.toml");

    expect(resolveOrRequestWorkspaceTarget).toHaveBeenCalledWith(
      "C:\\Users\\geral\\.ensemble-agent\\config.toml",
    );
    expect(begin).toHaveBeenCalledWith(
      "file:///C:/Users/geral/.ensemble-agent/config.toml",
    );

    await service.afterEdit("C:\\Users\\geral\\.ensemble-agent\\config.toml");

    expect(complete).toHaveBeenCalledWith(
      "file:///C:/Users/geral/.ensemble-agent/config.toml",
    );
  });
});
