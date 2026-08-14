import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type {
  ConfiguredModel,
  ModelCatalog,
  ModelReasoning,
  OpenAICompatibleModelInput,
  ReasoningEffort,
  WorkspaceModelOverride,
} from "./ModelTypes.js";
import { reasoningEfforts } from "./ModelTypes.js";

type JsonRecord = Record<string, unknown>;

export interface QwenSettingsPaths {
  readonly qwenDirectory: string;
  readonly settings: string;
  readonly environment: string;
  readonly workspaceSettings?: string;
}

export interface QwenSettingsSnapshot {
  readonly paths: QwenSettingsPaths;
  readonly settingsRaw?: string;
  readonly environmentRaw?: string;
  readonly settings: JsonRecord;
  readonly catalog: ModelCatalog;
}

export class QwenSettingsError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "invalid-json"
      | "unsupported-schema"
      | "concurrent-modification"
      | "workspace-override"
      | "validation",
  ) {
    super(message);
    this.name = "QwenSettingsError";
  }
}

export class QwenSettingsService {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory: () => string = homedir,
  ) {}

  paths(workspaceRoot?: string): QwenSettingsPaths {
    const qwenDirectory = resolveGlobalQwenDirectory(
      this.environment.QWEN_HOME,
      this.homeDirectory(),
    );
    return {
      qwenDirectory,
      settings: path.join(qwenDirectory, "settings.json"),
      environment: path.join(qwenDirectory, ".env"),
      ...(workspaceRoot === undefined
        ? {}
        : {
            workspaceSettings: path.join(
              workspaceRoot,
              ".qwen",
              "settings.json",
            ),
          }),
    };
  }

  async load(workspaceRoot?: string): Promise<QwenSettingsSnapshot> {
    const paths = this.paths(workspaceRoot);
    const [settingsRaw, environmentRaw, workspaceOverride] = await Promise.all([
      readOptional(paths.settings),
      readOptional(paths.environment),
      this.detectWorkspaceOverride(paths.workspaceSettings),
    ]);
    const settings = parseSettings(settingsRaw, paths.settings);
    const catalog = buildCatalog(
      settings,
      environmentRaw,
      this.environment,
      workspaceOverride,
    );
    return {
      paths,
      ...(settingsRaw === undefined ? {} : { settingsRaw }),
      ...(environmentRaw === undefined ? {} : { environmentRaw }),
      settings,
      catalog,
    };
  }

  async selectModel(
    snapshot: QwenSettingsSnapshot,
    modelKey: string,
  ): Promise<QwenSettingsSnapshot> {
    this.assertWritable(snapshot);
    const selected = snapshot.catalog.models.find(
      (model) => model.key === modelKey,
    );
    if (selected === undefined) {
      throw new QwenSettingsError(
        "That Qwen model is no longer present in settings.json. Refresh the model list and try again.",
        "concurrent-modification",
      );
    }
    const next = structuredClone(snapshot.settings);
    const currentModel = asRecord(next.model) ?? {};
    next.model = {
      ...currentModel,
      name: selected.id,
      baseUrl: selected.baseUrl,
    };
    const security = asRecord(next.security) ?? {};
    const auth = asRecord(security.auth) ?? {};
    next.security = {
      ...security,
      auth: { ...auth, selectedType: selected.authType },
    };
    await this.commitSettings(snapshot, next);
    return this.load(workspaceRootFromPaths(snapshot.paths));
  }

  async upsertOpenAIModel(
    snapshot: QwenSettingsSnapshot,
    input: OpenAICompatibleModelInput,
    existingKey?: string,
  ): Promise<{
    readonly snapshot: QwenSettingsSnapshot;
    readonly modelKey: string;
  }> {
    this.assertWritable(snapshot);
    const normalized = validateModelInput(input);
    const next = structuredClone(snapshot.settings);
    const providers = asRecord(next.modelProviders) ?? {};
    const openAIValue = providers.openai;
    if (openAIValue !== undefined && !Array.isArray(openAIValue)) {
      throw new QwenSettingsError(
        "This bundled Qwen version requires modelProviders.openai to be an array. The existing value uses an unsupported schema, so it was not modified.",
        "unsupported-schema",
      );
    }
    const entries: unknown[] = Array.isArray(openAIValue)
      ? Array.from(openAIValue as unknown[])
      : [];
    const existingIndex =
      existingKey === undefined
        ? -1
        : entries.findIndex(
            (entry) => modelKey("openai", entry) === existingKey,
          );
    if (existingKey !== undefined && existingIndex === -1) {
      throw new QwenSettingsError(
        "The model changed in Qwen settings while it was being edited. Refresh and try again.",
        "concurrent-modification",
      );
    }
    const existing = asRecord(entries[existingIndex]) ?? {};
    const newKey = createModelKey("openai", normalized.id, normalized.baseUrl);
    const duplicate = entries.some(
      (entry, index) =>
        index !== existingIndex && modelKey("openai", entry) === newKey,
    );
    if (duplicate) {
      throw new QwenSettingsError(
        `The OpenAI-compatible model ${normalized.id} is already configured for ${normalized.baseUrl}.`,
        "validation",
      );
    }

    const existingGeneration = asRecord(existing.generationConfig) ?? {};
    const generationConfig: JsonRecord = { ...existingGeneration };
    setOptional(
      generationConfig,
      "contextWindowSize",
      normalized.contextWindowSize,
    );
    setOptional(generationConfig, "reasoning", normalized.reasoning);

    let envKey =
      typeof existing.envKey === "string" ? existing.envKey : undefined;
    if (normalized.token !== undefined) {
      envKey ??= createCredentialEnvironmentKey(
        normalized.id,
        normalized.baseUrl,
      );
    }
    const updated: JsonRecord = {
      ...existing,
      id: normalized.id,
      name: normalized.displayName,
      baseUrl: normalized.baseUrl,
      generationConfig,
    };
    setOptional(updated, "envKey", envKey);
    if (existingIndex === -1) {
      entries.push(updated);
    } else {
      entries[existingIndex] = updated;
    }
    next.modelProviders = { ...providers, openai: entries };

    await this.assertUnchanged(snapshot);
    if (normalized.token !== undefined && envKey !== undefined) {
      await this.commitEnvironment(snapshot, envKey, normalized.token);
    }
    await this.assertSettingsUnchanged(snapshot);
    await this.commitSettings(snapshot, next, false);
    const reloaded = await this.load(workspaceRootFromPaths(snapshot.paths));
    return { snapshot: reloaded, modelKey: newKey };
  }

  async ensureSettingsFile(workspaceRoot?: string): Promise<string> {
    const snapshot = await this.load(workspaceRoot);
    if (snapshot.settingsRaw === undefined) {
      await this.commitSettings(snapshot, snapshot.settings);
    }
    return snapshot.paths.settings;
  }

  private async detectWorkspaceOverride(
    workspaceSettingsPath: string | undefined,
  ): Promise<WorkspaceModelOverride | undefined> {
    if (workspaceSettingsPath === undefined) {
      return undefined;
    }
    const raw = await readOptional(workspaceSettingsPath);
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        isRecord(parsed) &&
        Object.prototype.hasOwnProperty.call(parsed, "modelProviders")
      ) {
        return { path: workspaceSettingsPath, invalid: false };
      }
      return undefined;
    } catch {
      return { path: workspaceSettingsPath, invalid: true };
    }
  }

  private assertWritable(snapshot: QwenSettingsSnapshot): void {
    if (snapshot.catalog.workspaceOverride !== undefined) {
      throw new QwenSettingsError(
        `Workspace Qwen settings override model providers at ${snapshot.catalog.workspaceOverride.path}. Konnits-Coder will not modify project settings automatically.`,
        "workspace-override",
      );
    }
  }

  private async assertUnchanged(snapshot: QwenSettingsSnapshot): Promise<void> {
    const [settingsRaw, environmentRaw] = await Promise.all([
      readOptional(snapshot.paths.settings),
      readOptional(snapshot.paths.environment),
    ]);
    if (
      settingsRaw !== snapshot.settingsRaw ||
      environmentRaw !== snapshot.environmentRaw
    ) {
      throw new QwenSettingsError(
        "Qwen settings changed while this action was open. No settings were overwritten; refresh and try again.",
        "concurrent-modification",
      );
    }
  }

  private async assertSettingsUnchanged(
    snapshot: QwenSettingsSnapshot,
  ): Promise<void> {
    const settingsRaw = await readOptional(snapshot.paths.settings);
    if (settingsRaw !== snapshot.settingsRaw) {
      throw new QwenSettingsError(
        "Qwen settings changed while this action was open. The external settings change was preserved; refresh and try again.",
        "concurrent-modification",
      );
    }
  }

  private async commitSettings(
    snapshot: QwenSettingsSnapshot,
    settings: JsonRecord,
    verify = true,
  ): Promise<void> {
    if (verify) {
      await this.assertUnchanged(snapshot);
    }
    await fs.mkdir(snapshot.paths.qwenDirectory, { recursive: true });
    await backupOnce(snapshot.paths.settings, snapshot.settingsRaw);
    await atomicWrite(
      snapshot.paths.settings,
      `${JSON.stringify(settings, undefined, 2)}\n`,
    );
  }

  private async commitEnvironment(
    snapshot: QwenSettingsSnapshot,
    envKey: string,
    token: string,
  ): Promise<void> {
    if (/\r|\n/u.test(token)) {
      throw new QwenSettingsError(
        "API tokens cannot contain line breaks.",
        "validation",
      );
    }
    await fs.mkdir(snapshot.paths.qwenDirectory, { recursive: true });
    await backupOnce(snapshot.paths.environment, snapshot.environmentRaw);
    const next = updateDotEnv(snapshot.environmentRaw ?? "", envKey, token);
    await atomicWrite(snapshot.paths.environment, next, 0o600);
  }
}

export function resolveGlobalQwenDirectory(
  qwenHome: string | undefined,
  home: string,
): string {
  const configured = qwenHome?.trim();
  if (configured !== undefined && configured.length > 0) {
    return path.resolve(configured);
  }
  const base = home.length > 0 ? home : tmpdir();
  return path.join(base, ".qwen");
}

export function normalizeOpenAIBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new QwenSettingsError(
      "Enter a complete HTTP or HTTPS base URL, such as http://192.168.1.20:1234/v1.",
      "validation",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new QwenSettingsError(
      "The model base URL must use HTTP or HTTPS.",
      "validation",
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new QwenSettingsError(
      "Do not put credentials in the model URL. Use the API token field instead.",
      "validation",
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new QwenSettingsError(
      "The model base URL cannot contain a query string or fragment.",
      "validation",
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${pathname}`;
}

export function isInsecureRemoteBaseUrl(value: string): boolean {
  const parsed = new URL(normalizeOpenAIBaseUrl(value));
  if (parsed.protocol !== "http:") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return !(
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function parseSettings(
  raw: string | undefined,
  settingsPath: string,
): JsonRecord {
  if (raw === undefined) {
    return { $version: 4 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("root is not an object");
    }
    return parsed;
  } catch {
    throw new QwenSettingsError(
      `Qwen settings at ${settingsPath} are not valid JSON. Fix or restore the file before using model management; it was not overwritten.`,
      "invalid-json",
    );
  }
}

function buildCatalog(
  settings: JsonRecord,
  environmentRaw: string | undefined,
  processEnvironment: NodeJS.ProcessEnv,
  workspaceOverride: WorkspaceModelOverride | undefined,
): ModelCatalog {
  const environmentKeys = readDotEnvKeys(environmentRaw ?? "");
  const settingsEnvironment = asRecord(settings.env) ?? {};
  const providers = asRecord(settings.modelProviders) ?? {};
  const models: ConfiguredModel[] = [];
  for (const [authType, entries] of Object.entries(providers)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const record = asRecord(entry);
      if (record === undefined || typeof record.id !== "string") {
        continue;
      }
      const id = record.id.trim();
      if (id.length === 0) {
        continue;
      }
      const rawBaseUrl =
        typeof record.baseUrl === "string" ? record.baseUrl : "";
      let baseUrl = rawBaseUrl.trim();
      if (baseUrl.length > 0) {
        try {
          baseUrl = normalizeOpenAIBaseUrl(baseUrl);
        } catch {
          // Keep malformed existing values visible so the user can edit them.
        }
      }
      const generation = asRecord(record.generationConfig);
      const contextWindowSize = readPositiveInteger(
        generation?.contextWindowSize,
      );
      const reasoning = readReasoning(generation?.reasoning);
      const envKey =
        typeof record.envKey === "string" ? record.envKey : undefined;
      const credentialConfigured =
        envKey !== undefined &&
        (typeof processEnvironment[envKey] === "string" ||
          environmentKeys.has(envKey) ||
          typeof settingsEnvironment[envKey] === "string");
      models.push({
        key: createModelKey(authType, id, baseUrl),
        authType,
        id,
        displayName:
          typeof record.name === "string" && record.name.trim().length > 0
            ? record.name.trim()
            : id,
        baseUrl,
        ...(contextWindowSize === undefined ? {} : { contextWindowSize }),
        ...(reasoning === undefined ? {} : { reasoning }),
        credentialConfigured,
      });
    }
  }
  const activeName = readString(asRecord(settings.model)?.name);
  const activeBaseUrl = readString(asRecord(settings.model)?.baseUrl) ?? "";
  const activeAuthType = readString(
    asRecord(asRecord(settings.security)?.auth)?.selectedType,
  );
  const normalizedActiveBase = normalizeExistingBaseUrl(activeBaseUrl);
  const active = models.find(
    (model) =>
      model.id === activeName &&
      (activeAuthType === undefined || model.authType === activeAuthType) &&
      normalizeExistingBaseUrl(model.baseUrl) === normalizedActiveBase,
  );
  return {
    models,
    ...(active === undefined ? {} : { active }),
    ...(active === undefined && activeName !== undefined
      ? { activeUnconfiguredName: activeName }
      : {}),
    ...(workspaceOverride === undefined ? {} : { workspaceOverride }),
  };
}

function validateModelInput(
  input: OpenAICompatibleModelInput,
): OpenAICompatibleModelInput & { readonly baseUrl: string } {
  const displayName = input.displayName.trim();
  const id = input.id.trim();
  if (displayName.length === 0 || id.length === 0) {
    throw new QwenSettingsError(
      "Display name and model ID are required.",
      "validation",
    );
  }
  if (
    input.contextWindowSize !== undefined &&
    (!Number.isSafeInteger(input.contextWindowSize) ||
      input.contextWindowSize <= 0)
  ) {
    throw new QwenSettingsError(
      "Context window size must be a positive whole number.",
      "validation",
    );
  }
  return {
    ...input,
    displayName,
    id,
    baseUrl: normalizeOpenAIBaseUrl(input.baseUrl),
  };
}

function createModelKey(authType: string, id: string, baseUrl: string): string {
  return JSON.stringify([authType, id, normalizeExistingBaseUrl(baseUrl)]);
}

function modelKey(authType: string, value: unknown): string | undefined {
  const entry = asRecord(value);
  if (entry === undefined || typeof entry.id !== "string") {
    return undefined;
  }
  return createModelKey(
    authType,
    entry.id.trim(),
    typeof entry.baseUrl === "string" ? entry.baseUrl : "",
  );
}

function createCredentialEnvironmentKey(id: string, baseUrl: string): string {
  const digest = createHash("sha256")
    .update(`openai\0${id}\0${baseUrl}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `KONNITS_OPENAI_API_KEY_${digest}`;
}

function readReasoning(value: unknown): ModelReasoning | undefined {
  if (value === false) {
    return false;
  }
  const effort = readString(asRecord(value)?.effort);
  if (
    effort !== undefined &&
    reasoningEfforts.includes(effort as ReasoningEffort)
  ) {
    return { effort: effort as ReasoningEffort };
  }
  return undefined;
}

function updateDotEnv(raw: string, key: string, token: string): string {
  const assignment = `${key}=${JSON.stringify(token)}`;
  const lines = raw.split(/\r?\n/u);
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`,
    "u",
  );
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) {
    const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
    return `${raw}${prefix}${assignment}\n`;
  }
  lines[index] = assignment;
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function readDotEnvKeys(raw: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    if (match?.[1] !== undefined) {
      keys.add(match[1]);
    }
  }
  return keys;
}

async function backupOnce(
  filePath: string,
  original: string | undefined,
): Promise<void> {
  if (original === undefined) {
    return;
  }
  try {
    await fs.copyFile(
      filePath,
      `${filePath}.konnits-backup`,
      fileConstants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }
}

async function atomicWrite(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function workspaceRootFromPaths(paths: QwenSettingsPaths): string | undefined {
  return paths.workspaceSettings === undefined
    ? undefined
    : path.dirname(path.dirname(paths.workspaceSettings));
}

function normalizeExistingBaseUrl(value: string): string {
  if (value.length === 0) {
    return "";
  }
  try {
    return normalizeOpenAIBaseUrl(value);
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

function setOptional(record: JsonRecord, key: string, value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(record, key);
  } else {
    record[key] = value;
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
