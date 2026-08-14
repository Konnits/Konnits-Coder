export const reasoningEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

export type ModelReasoning = false | { readonly effort: ReasoningEffort };

export interface ConfiguredModel {
  readonly key: string;
  readonly authType: string;
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly contextWindowSize?: number;
  readonly reasoning?: ModelReasoning;
  readonly credentialConfigured: boolean;
}

export interface OpenAICompatibleModelInput {
  readonly displayName: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly contextWindowSize?: number;
  readonly reasoning?: ModelReasoning;
  /** Undefined preserves an existing credential or configures no credential. */
  readonly token?: string;
}

export interface WorkspaceModelOverride {
  readonly path: string;
  readonly invalid: boolean;
}

export interface ModelCatalog {
  readonly models: readonly ConfiguredModel[];
  readonly active?: ConfiguredModel;
  readonly activeUnconfiguredName?: string;
  readonly workspaceOverride?: WorkspaceModelOverride;
}

export interface ModelSelectorViewState {
  readonly label: string;
  readonly description?: string;
  readonly configuredCount: number;
  readonly credentialConfigured?: boolean;
  readonly warning?: string;
  readonly error?: string;
}

export interface ModelPickerResult {
  readonly modelChanged: boolean;
}

export interface ModelManagement {
  loadState(): Promise<ModelSelectorViewState>;
  showPicker(): Promise<ModelPickerResult>;
  addModel(): Promise<ModelPickerResult>;
  openSettings(): Promise<void>;
}
