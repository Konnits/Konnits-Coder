import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging/Logger.js";
import type { OpenAICompatibleEndpointProbe } from "../../src/models/OpenAICompatibleEndpointProbe.js";
import type {
  QwenSettingsService,
  QwenSettingsSnapshot,
} from "../../src/models/QwenSettingsService.js";

const showInputBox = vi.fn();
const showQuickPick = vi.fn();
const showWarningMessage = vi.fn();
const showInformationMessage = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "C:\\workspace" } }],
    openTextDocument: vi.fn(),
  },
  Uri: { file: (value: string) => ({ fsPath: value }) },
  window: {
    showInputBox,
    showQuickPick,
    showWarningMessage,
    showInformationMessage,
    showErrorMessage: vi.fn(),
    showTextDocument: vi.fn(),
  },
}));

describe("ModelManagementController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects tokens only through a native password input and never probes during save-only", async () => {
    const emptySnapshot = snapshot([]);
    const savedSnapshot = snapshot([
      {
        key: "remote-key",
        authType: "openai",
        id: "qwen",
        displayName: "Computer B",
        baseUrl: "http://192.168.1.20:1234/v1",
        credentialConfigured: true,
      },
    ]);
    const settings = {
      load: vi.fn(async () => emptySnapshot),
      upsertOpenAIModel: vi.fn(async () => ({
        snapshot: savedSnapshot,
        modelKey: "remote-key",
      })),
      selectModel: vi.fn(),
      paths: vi.fn(() => emptySnapshot.paths),
    };
    const probe = { test: vi.fn() };
    showQuickPick
      .mockResolvedValueOnce({ action: "add" })
      .mockResolvedValueOnce({ label: "Provider default", value: "default" })
      .mockResolvedValueOnce({ label: "Save without testing", value: "save" });
    showInputBox
      .mockResolvedValueOnce("Computer B")
      .mockResolvedValueOnce("qwen")
      .mockResolvedValueOnce("http://192.168.1.20:1234/v1")
      .mockResolvedValueOnce("262144")
      .mockResolvedValueOnce("native-secret");
    showWarningMessage.mockResolvedValueOnce("Continue");
    showInformationMessage.mockResolvedValueOnce("Not Now");

    const { ModelManagementController } =
      await import("../../src/models/ModelManagementController.js");
    const controller = new ModelManagementController(
      settings as unknown as QwenSettingsService,
      probe as unknown as OpenAICompatibleEndpointProbe,
      { info: vi.fn() } as unknown as Logger,
    );
    await controller.showPicker();

    expect(showInputBox.mock.calls[4]?.[0]).toMatchObject({ password: true });
    expect(settings.upsertOpenAIModel).toHaveBeenCalledWith(
      emptySnapshot,
      expect.objectContaining({ token: "native-secret" }),
      undefined,
    );
    expect(probe.test).not.toHaveBeenCalled();
    expect(JSON.stringify(await controller.loadState())).not.toContain(
      "native-secret",
    );
  });
});

function snapshot(
  models: QwenSettingsSnapshot["catalog"]["models"],
): QwenSettingsSnapshot {
  return {
    paths: {
      qwenDirectory: "C:\\qwen",
      settings: "C:\\qwen\\settings.json",
      environment: "C:\\qwen\\.env",
      workspaceSettings: "C:\\workspace\\.qwen\\settings.json",
    },
    settingsRaw: "{}",
    settings: {},
    catalog: { models },
  };
}
