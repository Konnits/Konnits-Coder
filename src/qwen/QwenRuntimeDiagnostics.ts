import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const moduleRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

export type QwenCliSource = "bundled" | "configured";

export interface QwenRuntimeExecutable {
  readonly source: QwenCliSource;
  readonly executable: string;
}

export interface QwenSettingsSummary {
  readonly settingsPath: string;
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly credentialConfigured: boolean;
  readonly credentialSource?: "process environment" | "settings.env";
  readonly secrets: readonly string[];
  readonly warnings: readonly string[];
}

export interface QwenRuntimeDiagnostics extends QwenSettingsSummary {
  readonly sdkVersion: string;
  readonly cliSource: QwenCliSource;
  readonly cliExecutable: string;
  readonly cliVersion: string;
}

export function resolveQwenRuntimeExecutable(
  configuredPath: string | undefined,
  sdkEntryPath: string,
): QwenRuntimeExecutable {
  if (configuredPath !== undefined) {
    return { source: "configured", executable: configuredPath };
  }
  return {
    source: "bundled",
    executable: join(dirname(sdkEntryPath), "cli", "cli.js"),
  };
}

export function summarizeQwenSettings(
  value: unknown,
  settingsPath: string,
  environment: Readonly<Record<string, string | undefined>>,
): QwenSettingsSummary {
  const settings = asRecord(value);
  const security = asRecord(settings?.security);
  const auth = asRecord(security?.auth);
  const provider = readString(auth?.selectedType);
  const selectedModel = asRecord(settings?.model);
  const model = readString(selectedModel?.name);
  const selectedBaseUrl = readString(selectedModel?.baseUrl);
  const providerGroups = asRecord(settings?.modelProviders);
  const providerModels =
    provider === undefined ? undefined : providerGroups?.[provider];
  const matchingModel = Array.isArray(providerModels)
    ? (providerModels
        .map(asRecord)
        .find(
          (candidate) =>
            readString(candidate?.id) === model &&
            (selectedBaseUrl === undefined ||
              readString(candidate?.baseUrl) === selectedBaseUrl),
        ) ??
      providerModels
        .map(asRecord)
        .find((candidate) => readString(candidate?.id) === model))
    : undefined;
  const envKey = readString(matchingModel?.envKey);
  const settingsEnv = asRecord(settings?.env);
  const processCredential =
    envKey === undefined ? undefined : environment[envKey];
  const settingsCredential =
    envKey === undefined ? undefined : readString(settingsEnv?.[envKey]);
  const baseUrl = readString(matchingModel?.baseUrl) ?? selectedBaseUrl;
  const secrets = Object.values(settingsEnv ?? {}).filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  if (processCredential !== undefined && processCredential.length > 0) {
    secrets.push(processCredential);
  }

  return {
    settingsPath,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    credentialConfigured:
      (processCredential !== undefined && processCredential.length > 0) ||
      settingsCredential !== undefined,
    ...(processCredential !== undefined && processCredential.length > 0
      ? { credentialSource: "process environment" as const }
      : settingsCredential === undefined
        ? {}
        : { credentialSource: "settings.env" as const }),
    secrets,
    warnings: generationConfigurationWarnings(matchingModel),
  };
}

export async function inspectQwenRuntime(
  configuredPath?: string,
): Promise<QwenRuntimeDiagnostics> {
  const sdkEntryPath = moduleRequire.resolve("@qwen-code/sdk");
  const executable = resolveQwenRuntimeExecutable(configuredPath, sdkEntryPath);
  const sdkPackagePath = join(dirname(dirname(sdkEntryPath)), "package.json");
  const sdkPackage = asRecord(
    JSON.parse(await readFile(sdkPackagePath, "utf8")) as unknown,
  );
  const settingsPath = join(
    process.env.QWEN_HOME ?? join(homedir(), ".qwen"),
    "settings.json",
  );
  let settings: unknown = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
  } catch {
    // Qwen will provide the actionable parse/not-found error when it launches.
  }
  const settingsSummary = summarizeQwenSettings(
    settings,
    settingsPath,
    process.env,
  );

  return {
    ...settingsSummary,
    sdkVersion: readString(sdkPackage?.version) ?? "unknown",
    cliSource: executable.source,
    cliExecutable: executable.executable,
    cliVersion: await readCliVersion(executable.executable),
  };
}

export function formatQwenRuntimeDiagnostics(
  diagnostics: QwenRuntimeDiagnostics,
  workspacePath?: string,
): readonly string[] {
  return [
    "Qwen execution configuration:",
    `SDK version: ${diagnostics.sdkVersion}`,
    `CLI source: ${diagnostics.cliSource}`,
    `CLI executable: ${diagnostics.cliExecutable}`,
    `CLI version: ${diagnostics.cliVersion}`,
    `Settings: ${diagnostics.settingsPath}`,
    ...(workspacePath === undefined ? [] : [`Workspace: ${workspacePath}`]),
    `Model: ${diagnostics.model ?? "not configured"}`,
    `Provider: ${diagnostics.provider ?? "not configured"}`,
    `Base URL: ${diagnostics.baseUrl ?? "not configured"}`,
    `Credential configured: ${diagnostics.credentialConfigured ? "yes" : "no"}`,
    `Credential source: ${diagnostics.credentialSource ?? "not found"}`,
    ...diagnostics.warnings.map(
      (warning) => `Configuration warning: ${warning}`,
    ),
  ];
}

async function readCliVersion(executable: string): Promise<string> {
  try {
    const extension = extname(executable).toLowerCase();
    const command = [".js", ".mjs", ".cjs"].includes(extension)
      ? process.execPath
      : executable;
    const args =
      command === process.execPath ? [executable, "--version"] : ["--version"];
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 5_000,
      windowsHide: true,
    });
    return `${stdout}${stderr}`.trim().split(/\r?\n/u)[0] ?? "unknown";
  } catch {
    return "unavailable";
  }
}

function generationConfigurationWarnings(
  model: Record<string, unknown> | undefined,
): readonly string[] {
  const generation = asRecord(model?.generationConfig);
  const extraBody = asRecord(generation?.extra_body);
  const misplaced = ["maxRetries", "contextWindowSize"].filter(
    (key) => extraBody?.[key] !== undefined,
  );
  return misplaced.length === 0
    ? []
    : [
        `${misplaced.join(", ")} must be direct generationConfig fields; extra_body is only for provider request-body parameters.`,
      ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
