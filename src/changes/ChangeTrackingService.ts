import type * as vscode from "vscode";
import type { ChangeManager } from "./ChangeManager.js";
import type { VsCodeFileSystem } from "./VsCodeFileSystem.js";

type ChangeTargetResolver = Pick<
  VsCodeFileSystem,
  "resolveOrRequestWorkspaceTarget" | "resolveWorkspaceTarget"
>;

export class ChangeTrackingService {
  private readonly activeTargets = new Map<string, vscode.Uri>();

  constructor(
    private readonly manager: ChangeManager,
    private readonly fileSystem: ChangeTargetResolver,
  ) {}

  async beforeEdit(target: string): Promise<void> {
    const uri = await this.fileSystem.resolveOrRequestWorkspaceTarget(target);
    await this.manager.begin(uri.toString());
    this.activeTargets.set(target, uri);
  }

  async afterEdit(target: string): Promise<void> {
    const uri =
      this.activeTargets.get(target) ??
      this.fileSystem.resolveWorkspaceTarget(target);
    try {
      await this.manager.complete(uri.toString());
    } finally {
      this.activeTargets.delete(target);
    }
  }

  async completeAll(): Promise<void> {
    try {
      await this.manager.completeAll();
    } finally {
      this.activeTargets.clear();
    }
  }
}
