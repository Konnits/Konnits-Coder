import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type {
  AgentPermissionModeHost,
  AgentPermissionModeManagement,
} from "../../src/permissions/AgentPermissionModeService.js";
import type { AgentPermissionMode } from "../../src/permissions/AgentPermissionMode.js";

const vscodeMocks = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  getConfiguration: vi.fn(),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Workspace: 2 },
  window: {
    showQuickPick: vscodeMocks.showQuickPick,
    showWarningMessage: vscodeMocks.showWarningMessage,
  },
  workspace: { getConfiguration: vscodeMocks.getConfiguration },
}));

describe("AgentPermissionModeService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("keeps an unacknowledged full-access setting fail-closed", async () => {
    const host = new FakePermissionModeHost("yolo", false);
    const service = await createService(host);

    expect(service.current()).toBe("default");
  });

  it("enables full access only after the explicit risk confirmation", async () => {
    const host = new FakePermissionModeHost("default", false);
    host.nextPick = "yolo";
    host.nextConfirmation = true;
    const service = await createService(host);
    const listener = vi.fn();
    service.onDidChange(listener);

    await service.select();

    expect(host.confirmations).toBe(1);
    expect(host.configuredMode).toBe("yolo");
    expect(host.acknowledged).toBe(true);
    expect(service.current()).toBe("yolo");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not change modes when the full-access warning is rejected", async () => {
    const host = new FakePermissionModeHost("default", false);
    host.nextPick = "yolo";
    host.nextConfirmation = false;
    const service = await createService(host);

    await service.select();

    expect(host.configuredMode).toBe("default");
    expect(host.acknowledged).toBe(false);
  });

  it("requires confirmation for a full-access value written outside the picker", async () => {
    const host = new FakePermissionModeHost("yolo", false);
    host.nextConfirmation = false;
    const service = await createService(host);

    await service.reconcile();

    expect(host.confirmations).toBe(1);
    expect(host.configuredMode).toBe("default");
    expect(service.current()).toBe("default");
  });

  it("honors an externally written full-access value after confirmation", async () => {
    const host = new FakePermissionModeHost("yolo", false);
    host.nextConfirmation = true;
    const service = await createService(host);

    await service.reconcile();

    expect(host.acknowledged).toBe(true);
    expect(service.current()).toBe("yolo");
  });

  it("clears the acknowledgement when returning to a safe mode", async () => {
    const host = new FakePermissionModeHost("yolo", true);
    host.nextPick = "plan";
    const service = await createService(host);

    await service.select();

    expect(host.configuredMode).toBe("plan");
    expect(host.acknowledged).toBe(false);
    expect(service.current()).toBe("plan");
  });

  it("uses a modal declaration that explains the full-access risks", async () => {
    vscodeMocks.showWarningMessage.mockResolvedValueOnce(
      "I understand — enable full access",
    );
    const { VsCodeAgentPermissionModeHost } =
      await import("../../src/permissions/AgentPermissionModeService.js");
    const host = new VsCodeAgentPermissionModeHost({
      get: vi.fn((_key: string, fallback: boolean) => fallback),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => []),
    } as unknown as vscode.Memento);

    await expect(host.confirmFullAccess()).resolves.toBe(true);
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("without asking for approval"),
      {
        modal: true,
        detail:
          "This bypasses Konnits Coder's per-tool approval and may bypass the snapshots used by Changed Files, prompt editing, and file restoration. Commands may also affect data outside the workspace when the environment permits it. By continuing, you declare that you understand and accept these risks.",
      },
      "I understand — enable full access",
    );
  });

  it("offers full access in the native permission picker", async () => {
    vscodeMocks.showQuickPick.mockResolvedValueOnce({
      label: "$(warning) Full access",
      mode: "yolo",
    });
    const { VsCodeAgentPermissionModeHost } =
      await import("../../src/permissions/AgentPermissionModeService.js");
    const host = new VsCodeAgentPermissionModeHost({} as vscode.Memento);

    await expect(host.pickMode("default")).resolves.toBe("yolo");
    expect(vscodeMocks.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: "$(warning) Full access",
          description: "Confirmation required",
          mode: "yolo",
        }),
      ]),
      expect.objectContaining({ title: "Agent permissions" }),
    );
  });
});

async function createService(
  host: AgentPermissionModeHost,
): Promise<AgentPermissionModeManagement> {
  const { AgentPermissionModeService } =
    await import("../../src/permissions/AgentPermissionModeService.js");
  return new AgentPermissionModeService(host);
}

class FakePermissionModeHost implements AgentPermissionModeHost {
  nextPick: AgentPermissionMode | undefined;
  nextConfirmation = false;
  confirmations = 0;

  constructor(
    public configuredMode: string,
    public acknowledged: boolean,
  ) {}

  readConfiguredMode(): string {
    return this.configuredMode;
  }

  writeConfiguredMode(mode: AgentPermissionMode): Promise<void> {
    this.configuredMode = mode;
    return Promise.resolve();
  }

  readFullAccessAcknowledgement(): boolean {
    return this.acknowledged;
  }

  writeFullAccessAcknowledgement(acknowledged: boolean): Promise<void> {
    this.acknowledged = acknowledged;
    return Promise.resolve();
  }

  pickMode(): Promise<AgentPermissionMode | undefined> {
    return Promise.resolve(this.nextPick);
  }

  confirmFullAccess(): Promise<boolean> {
    this.confirmations += 1;
    return Promise.resolve(this.nextConfirmation);
  }
}
