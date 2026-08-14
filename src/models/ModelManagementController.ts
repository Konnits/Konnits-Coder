import * as vscode from "vscode";
import type { Logger } from "../logging/Logger.js";
import type {
  ConfiguredModel,
  ModelManagement,
  ModelPickerResult,
  ModelReasoning,
  ModelSelectorViewState,
  OpenAICompatibleModelInput,
  ReasoningEffort,
} from "./ModelTypes.js";
import { reasoningEfforts } from "./ModelTypes.js";
import type { OpenAICompatibleEndpointProbe } from "./OpenAICompatibleEndpointProbe.js";
import {
  isInsecureRemoteBaseUrl,
  normalizeOpenAIBaseUrl,
  QwenSettingsError,
  type QwenSettingsSnapshot,
  type QwenSettingsService,
} from "./QwenSettingsService.js";

type MenuAction = "model" | "add" | "edit" | "open" | "refresh";

interface ModelMenuItem extends vscode.QuickPickItem {
  readonly action: MenuAction;
  readonly modelKey?: string;
}

export class ModelManagementController implements ModelManagement {
  constructor(
    private readonly settings: QwenSettingsService,
    private readonly probe: OpenAICompatibleEndpointProbe,
    private readonly logger: Logger,
  ) {}

  async loadState(): Promise<ModelSelectorViewState> {
    const snapshot = await this.settings.load(this.workspaceRoot());
    const active = snapshot.catalog.active;
    const label =
      active?.displayName ??
      snapshot.catalog.activeUnconfiguredName ??
      "Select model";
    const description =
      active === undefined
        ? undefined
        : active.baseUrl.length > 0
          ? active.baseUrl
          : active.authType;
    const override = snapshot.catalog.workspaceOverride;
    return {
      label,
      ...(description === undefined ? {} : { description }),
      configuredCount: snapshot.catalog.models.length,
      ...(active === undefined
        ? {}
        : { credentialConfigured: active.credentialConfigured }),
      ...(override === undefined
        ? {}
        : {
            warning: override.invalid
              ? `Workspace Qwen settings are invalid: ${override.path}`
              : `Workspace Qwen settings override user model providers: ${override.path}`,
          }),
    };
  }

  async showPicker(): Promise<ModelPickerResult> {
    let snapshot = await this.settings.load(this.workspaceRoot());
    if (await this.handleWorkspaceOverride(snapshot)) {
      return { modelChanged: false };
    }

    const selected = await vscode.window.showQuickPick(
      this.menuItems(snapshot),
      {
        placeHolder: "Select or manage the Qwen model used for new sessions",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (selected === undefined) {
      return { modelChanged: false };
    }
    switch (selected.action) {
      case "model":
        if (selected.modelKey === snapshot.catalog.active?.key) {
          return { modelChanged: false };
        }
        if (selected.modelKey === undefined) {
          return { modelChanged: false };
        }
        await this.settings.selectModel(snapshot, selected.modelKey);
        return { modelChanged: true };
      case "add": {
        const result = await this.configureModel(snapshot);
        if (result === undefined) {
          return { modelChanged: false };
        }
        snapshot = result.snapshot;
        if (await this.askToSelect(result.modelKey)) {
          await this.settings.selectModel(snapshot, result.modelKey);
          return { modelChanged: true };
        }
        return { modelChanged: false };
      }
      case "edit": {
        const model = await this.pickEditableModel(snapshot);
        if (model === undefined) {
          return this.showPicker();
        }
        const result = await this.configureModel(snapshot, model);
        if (result === undefined) {
          return { modelChanged: false };
        }
        snapshot = result.snapshot;
        if (
          snapshot.catalog.active?.key === result.modelKey ||
          (await this.askToSelect(result.modelKey))
        ) {
          await this.settings.selectModel(snapshot, result.modelKey);
          return { modelChanged: true };
        }
        return { modelChanged: false };
      }
      case "open":
        await this.openSettings();
        return { modelChanged: false };
      case "refresh":
        return this.showPicker();
    }
  }

  async addModel(): Promise<ModelPickerResult> {
    let snapshot = await this.settings.load(this.workspaceRoot());
    if (await this.handleWorkspaceOverride(snapshot)) {
      return { modelChanged: false };
    }
    const result = await this.configureModel(snapshot);
    if (result === undefined) {
      return { modelChanged: false };
    }
    snapshot = result.snapshot;
    if (await this.askToSelect(result.modelKey)) {
      await this.settings.selectModel(snapshot, result.modelKey);
      return { modelChanged: true };
    }
    return { modelChanged: false };
  }

  async openSettings(): Promise<void> {
    const fallbackPath = this.settings.paths(this.workspaceRoot()).settings;
    let settingsPath = fallbackPath;
    try {
      settingsPath = await this.settings.ensureSettingsFile(
        this.workspaceRoot(),
      );
    } catch (error) {
      if (
        !(error instanceof QwenSettingsError) ||
        error.kind !== "invalid-json"
      ) {
        throw error;
      }
    }
    await this.openFile(settingsPath);
  }

  private menuItems(snapshot: QwenSettingsSnapshot): readonly ModelMenuItem[] {
    const models = snapshot.catalog.models.map((model) => ({
      label: `${model.key === snapshot.catalog.active?.key ? "$(check) " : ""}${model.displayName}`,
      description: `${model.authType} · ${model.id}`,
      detail: modelDetail(model),
      action: "model" as const,
      modelKey: model.key,
    }));
    return [
      ...models,
      {
        label: "$(add) Add OpenAI-compatible model…",
        description: "LM Studio, vLLM, Ollama, or another compatible endpoint",
        action: "add",
      },
      {
        label: "$(edit) Edit a configured model…",
        action: "edit",
      },
      {
        label: "$(gear) Open Qwen user settings",
        description: this.settings.paths(this.workspaceRoot()).settings,
        action: "open",
      },
      {
        label: "$(refresh) Refresh model list",
        action: "refresh",
      },
    ];
  }

  private async pickEditableModel(
    snapshot: QwenSettingsSnapshot,
  ): Promise<ConfiguredModel | undefined> {
    const editable = snapshot.catalog.models.filter(
      (model) => model.authType === "openai",
    );
    if (editable.length === 0) {
      await vscode.window.showInformationMessage(
        "No OpenAI-compatible models are configured in Qwen user settings.",
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      editable.map((model) => ({
        label: model.displayName,
        description: model.id,
        detail: model.baseUrl,
        model,
      })),
      { placeHolder: "Choose an OpenAI-compatible model to edit" },
    );
    return picked?.model;
  }

  private async configureModel(
    snapshot: QwenSettingsSnapshot,
    existing?: ConfiguredModel,
  ): Promise<
    | { readonly snapshot: QwenSettingsSnapshot; readonly modelKey: string }
    | undefined
  > {
    const displayName = await vscode.window.showInputBox({
      title:
        existing === undefined
          ? "Add model — Display name"
          : "Edit model — Display name",
      prompt: "A short name shown in the Konnits-Coder model selector",
      value: existing?.displayName ?? "",
      ignoreFocusOut: true,
      validateInput: required("Display name"),
    });
    if (displayName === undefined) return undefined;

    const id = await vscode.window.showInputBox({
      title: "Model ID",
      prompt: "The exact ID returned by the OpenAI-compatible server",
      value: existing?.id ?? "",
      ignoreFocusOut: true,
      validateInput: required("Model ID"),
    });
    if (id === undefined) return undefined;

    const baseUrl = await vscode.window.showInputBox({
      title: "OpenAI-compatible base URL",
      prompt:
        "Include /v1 when required, for example http://192.168.1.20:1234/v1",
      value: existing?.baseUrl ?? "http://localhost:1234/v1",
      ignoreFocusOut: true,
      validateInput: validateBaseUrl,
    });
    if (baseUrl === undefined) return undefined;
    const normalizedBaseUrl = normalizeOpenAIBaseUrl(baseUrl);
    if (isInsecureRemoteBaseUrl(normalizedBaseUrl)) {
      const action = await vscode.window.showWarningMessage(
        "This remote model connection uses unencrypted HTTP. Prompts, code context, and the API token may be visible on the network.",
        { modal: true },
        "Continue",
      );
      if (action !== "Continue") return undefined;
    }

    const contextWindowText = await vscode.window.showInputBox({
      title: "Context window",
      prompt:
        "Optional positive token capacity override; leave blank for the provider default",
      value:
        existing?.contextWindowSize === undefined
          ? ""
          : String(existing.contextWindowSize),
      ignoreFocusOut: true,
      validateInput: validateContextWindow,
    });
    if (contextWindowText === undefined) return undefined;
    const contextWindowSize =
      contextWindowText.trim().length === 0
        ? undefined
        : Number(contextWindowText.trim());

    const reasoning = await this.pickReasoning(existing?.reasoning);
    if (reasoning === "cancelled") return undefined;

    const token = await vscode.window.showInputBox({
      title: "API token",
      prompt:
        existing === undefined
          ? "Optional. Leave blank for an endpoint that does not require authentication."
          : "Optional. Leave blank to keep the current credential unchanged.",
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return undefined;
    const input: OpenAICompatibleModelInput = {
      displayName,
      id,
      baseUrl: normalizedBaseUrl,
      ...(contextWindowSize === undefined ? {} : { contextWindowSize }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(token.length === 0 ? {} : { token }),
    };

    const action = await vscode.window.showQuickPick(
      [
        {
          label: "$(plug) Test connection and save",
          description: `GET ${normalizedBaseUrl}/models`,
          value: "test" as const,
        },
        {
          label: "$(save) Save without testing",
          description: "The endpoint will be used by Qwen on the next session",
          value: "save" as const,
        },
      ],
      { placeHolder: "Test the endpoint before saving?" },
    );
    if (action === undefined) return undefined;
    if (action.value === "test") {
      const proceed = await this.testConnection(input);
      if (!proceed) return undefined;
    }

    const result = await this.settings.upsertOpenAIModel(
      snapshot,
      input,
      existing?.key,
    );
    this.logger.info(
      `Saved Qwen OpenAI-compatible model configuration: model=${id.trim()} baseUrl=${normalizedBaseUrl}.`,
    );
    return result;
  }

  private async testConnection(
    input: OpenAICompatibleModelInput,
  ): Promise<boolean> {
    try {
      const result = await this.probe.test(
        input.baseUrl,
        input.id,
        input.token,
      );
      if (!result.requestedModelFound) {
        const preview = result.modelIds.slice(0, 8).join(", ") || "none";
        const action = await vscode.window.showWarningMessage(
          `Connected successfully, but model ID “${input.id}” was not returned. Discovered models: ${preview}.`,
          "Save Anyway",
        );
        return action === "Save Anyway";
      }
      await vscode.window.showInformationMessage(
        `Connected to ${result.baseUrl}; model “${input.id}” is available.`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showErrorMessage(
        message,
        "Save Anyway",
      );
      return action === "Save Anyway";
    }
  }

  private async pickReasoning(
    current: ModelReasoning | undefined,
  ): Promise<ModelReasoning | undefined | "cancelled"> {
    const currentValue =
      current === false ? "off" : (current?.effort ?? "default");
    type ReasoningChoice = vscode.QuickPickItem & {
      readonly value: "default" | "off" | ReasoningEffort;
    };
    const baseChoices: readonly ReasoningChoice[] = [
      { label: "Provider default", value: "default" },
      { label: "Thinking off", value: "off" },
      ...reasoningEfforts.map((effort) => ({
        label: `Thinking effort: ${effort}`,
        value: effort,
      })),
    ];
    const choices: readonly ReasoningChoice[] = baseChoices.map((item) => ({
      ...item,
      ...(item.value === currentValue ? { description: "Current" } : {}),
    }));
    const picked = await vscode.window.showQuickPick(choices, {
      placeHolder: "Choose the model thinking/reasoning setting",
    });
    if (picked === undefined) return "cancelled";
    if (picked.value === "default") return undefined;
    if (picked.value === "off") return false;
    return { effort: picked.value };
  }

  private async askToSelect(modelKey: string): Promise<boolean> {
    const snapshot = await this.settings.load(this.workspaceRoot());
    const model = snapshot.catalog.models.find((item) => item.key === modelKey);
    const action = await vscode.window.showInformationMessage(
      `Saved ${model?.displayName ?? "the model"}. Select it and start a new session?`,
      "Select and Start New Session",
      "Not Now",
    );
    return action === "Select and Start New Session";
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async handleWorkspaceOverride(
    snapshot: QwenSettingsSnapshot,
  ): Promise<boolean> {
    const override = snapshot.catalog.workspaceOverride;
    if (override === undefined) {
      return false;
    }
    const action = await vscode.window.showWarningMessage(
      override.invalid
        ? "Workspace .qwen/settings.json is invalid. Konnits-Coder will not overwrite it or user model settings while the effective scope is unclear."
        : "This workspace defines modelProviders in .qwen/settings.json. It overrides user models, and Konnits-Coder will not modify project settings automatically.",
      "Open Workspace Settings",
    );
    if (action === "Open Workspace Settings") {
      await this.openFile(override.path);
    }
    return true;
  }

  private async openFile(filePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath),
    );
    await vscode.window.showTextDocument(document);
  }
}

function required(label: string): (value: string) => string | undefined {
  return (value) =>
    value.trim().length === 0 ? `${label} is required.` : undefined;
}

function validateBaseUrl(value: string): string | undefined {
  try {
    normalizeOpenAIBaseUrl(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateContextWindow(value: string): string | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0
    ? undefined
    : "Enter a positive whole number or leave this blank.";
}

function modelDetail(model: ConfiguredModel): string {
  const details = [model.baseUrl || "Default endpoint"];
  if (model.contextWindowSize !== undefined) {
    details.push(`${String(model.contextWindowSize)} context tokens`);
  }
  if (model.reasoning === false) {
    details.push("thinking off");
  } else if (model.reasoning !== undefined) {
    details.push(`thinking ${model.reasoning.effort}`);
  }
  details.push(
    model.credentialConfigured
      ? "credential configured"
      : "no credential detected",
  );
  return details.join(" · ");
}
