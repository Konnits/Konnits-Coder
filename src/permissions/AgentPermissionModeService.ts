import * as vscode from "vscode";
import {
  parseAgentPermissionMode,
  type AgentPermissionMode,
} from "./AgentPermissionMode.js";

const FULL_ACCESS_ACKNOWLEDGEMENT_KEY =
  "qwenFrontend.permission.fullAccessAcknowledged.v1";
const ENABLE_FULL_ACCESS_ACTION = "I understand — enable full access";

export interface AgentPermissionModeManagement {
  current(): AgentPermissionMode;
  select(): Promise<void>;
  reconcile(): Promise<void>;
  onDidChange(listener: () => void): vscode.Disposable;
}

export interface AgentPermissionModeHost {
  readConfiguredMode(): string;
  writeConfiguredMode(mode: AgentPermissionMode): Promise<void>;
  readFullAccessAcknowledgement(): boolean;
  writeFullAccessAcknowledgement(acknowledged: boolean): Promise<void>;
  pickMode(
    current: AgentPermissionMode,
  ): Promise<AgentPermissionMode | undefined>;
  confirmFullAccess(): Promise<boolean>;
}

export class AgentPermissionModeService
  implements AgentPermissionModeManagement, vscode.Disposable
{
  private readonly listeners = new Set<() => void>();
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly host: AgentPermissionModeHost) {}

  current(): AgentPermissionMode {
    const configured = parseAgentPermissionMode(this.host.readConfiguredMode());
    if (configured === "yolo" && !this.host.readFullAccessAcknowledgement()) {
      return "default";
    }
    return configured;
  }

  select(): Promise<void> {
    return this.enqueue(async () => {
      const selected = await this.host.pickMode(this.current());
      if (
        selected === undefined ||
        (selected === this.current() &&
          selected === parseAgentPermissionMode(this.host.readConfiguredMode()))
      ) {
        return;
      }
      if (selected === "yolo" && !(await this.host.confirmFullAccess())) {
        return;
      }

      const previouslyAcknowledged = this.host.readFullAccessAcknowledgement();
      try {
        await this.host.writeFullAccessAcknowledgement(selected === "yolo");
        await this.host.writeConfiguredMode(selected);
      } catch (error) {
        await this.host.writeFullAccessAcknowledgement(previouslyAcknowledged);
        throw error;
      }
      this.emitChange();
    });
  }

  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      const configured = parseAgentPermissionMode(
        this.host.readConfiguredMode(),
      );
      const acknowledged = this.host.readFullAccessAcknowledgement();
      if (configured === "yolo" && !acknowledged) {
        if (await this.host.confirmFullAccess()) {
          await this.host.writeFullAccessAcknowledgement(true);
        } else {
          await this.host.writeConfiguredMode("default");
        }
        this.emitChange();
        return;
      }
      if (configured !== "yolo" && acknowledged) {
        await this.host.writeFullAccessAcknowledgement(false);
      }
      this.emitChange();
    });
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.listeners.clear();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation, operation);
    this.operation = result.catch(() => undefined);
    return result;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface PermissionModeQuickPickItem extends vscode.QuickPickItem {
  readonly mode: AgentPermissionMode;
}

export class VsCodeAgentPermissionModeHost implements AgentPermissionModeHost {
  constructor(private readonly workspaceState: vscode.Memento) {}

  readConfiguredMode(): string {
    return vscode.workspace
      .getConfiguration("qwenFrontend")
      .get<string>("qwen.permissionMode", "default");
  }

  async writeConfiguredMode(mode: AgentPermissionMode): Promise<void> {
    await vscode.workspace
      .getConfiguration("qwenFrontend")
      .update(
        "qwen.permissionMode",
        mode,
        vscode.ConfigurationTarget.Workspace,
      );
  }

  readFullAccessAcknowledgement(): boolean {
    return this.workspaceState.get<boolean>(
      FULL_ACCESS_ACKNOWLEDGEMENT_KEY,
      false,
    );
  }

  async writeFullAccessAcknowledgement(acknowledged: boolean): Promise<void> {
    await this.workspaceState.update(
      FULL_ACCESS_ACKNOWLEDGEMENT_KEY,
      acknowledged,
    );
  }

  async pickMode(
    current: AgentPermissionMode,
  ): Promise<AgentPermissionMode | undefined> {
    const items: readonly PermissionModeQuickPickItem[] = [
      {
        label: "$(lock) Ask before sensitive actions",
        ...(current === "default" ? { description: "Current" } : {}),
        detail: "Qwen requests approval before writes and commands.",
        mode: "default",
      },
      {
        label: "$(inspect) Plan only",
        ...(current === "plan" ? { description: "Current" } : {}),
        detail: "Qwen can analyze the workspace but cannot modify it.",
        mode: "plan",
      },
      {
        label: "$(warning) Full access",
        description: current === "yolo" ? "Current" : "Confirmation required",
        detail: "Qwen can run every tool without asking for approval.",
        mode: "yolo",
      },
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: "Agent permissions",
      placeHolder: "Choose the permission mode for new agent turns",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return selected?.mode;
  }

  async confirmFullAccess(): Promise<boolean> {
    const selected = await vscode.window.showWarningMessage(
      "Full access lets Qwen run commands and modify or delete files without asking for approval.",
      {
        modal: true,
        detail:
          "This bypasses Konnits Coder's per-tool approval and may bypass the snapshots used by Changed Files, prompt editing, and file restoration. Commands may also affect data outside the workspace when the environment permits it. By continuing, you declare that you understand and accept these risks.",
      },
      ENABLE_FULL_ACCESS_ACTION,
    );
    return selected === ENABLE_FULL_ACCESS_ACTION;
  }
}
