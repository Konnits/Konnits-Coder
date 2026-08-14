import type { ChangeManager } from "./ChangeManager.js";
import type { VsCodeFileSystem } from "./VsCodeFileSystem.js";

export class ChangeTrackingService {
  constructor(
    private readonly manager: ChangeManager,
    private readonly fileSystem: VsCodeFileSystem,
  ) {}

  async beforeEdit(target: string): Promise<void> {
    const uri = this.fileSystem.resolveWorkspaceTarget(target);
    await this.manager.begin(uri.toString());
  }

  async afterEdit(target: string): Promise<void> {
    const uri = this.fileSystem.resolveWorkspaceTarget(target);
    await this.manager.complete(uri.toString());
  }

  async completeAll(): Promise<void> {
    await this.manager.completeAll();
  }
}
