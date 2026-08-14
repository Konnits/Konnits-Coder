import type { ToolInput } from "@qwen-code/sdk";
import type { PermissionRisk } from "./toolRisk.js";

export interface PermissionRequest {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly risk: PermissionRisk;
  readonly detail?: string;
  readonly input: ToolInput;
}

export type PermissionDecision = "allow" | "deny";

interface PendingPermission {
  readonly request: PermissionRequest;
  readonly resolve: (decision: PermissionDecision) => void;
}

export class PermissionManager {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly listeners = new Set<() => void>();

  request(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    if (signal.aborted) {
      return Promise.resolve("deny");
    }
    return new Promise((resolve) => {
      const finish = (decision: PermissionDecision): void => {
        if (!this.pending.delete(request.id)) {
          return;
        }
        signal.removeEventListener("abort", abort);
        resolve(decision);
        this.emitChange();
      };
      const abort = (): void => finish("deny");

      this.pending.set(request.id, { request, resolve: finish });
      signal.addEventListener("abort", abort, { once: true });
      this.emitChange();
    });
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return false;
    }
    pending.resolve(decision);
    return true;
  }

  denyAll(): void {
    for (const item of [...this.pending.values()]) {
      item.resolve("deny");
    }
  }

  list(): readonly PermissionRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
