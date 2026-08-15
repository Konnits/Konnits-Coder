import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
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
  readonly credentialSource?: "process environment" | ".env" | "settings.env";
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
  environmentFile = "",
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
  const dotEnv = parseDotEnv(environmentFile);
  const processCredential =
    envKey === undefined ? undefined : environment[envKey];
  const dotEnvCredential = envKey === undefined ? undefined : dotEnv[envKey];
  const settingsCredential =
    envKey === undefined ? undefined : readString(settingsEnv?.[envKey]);
  const baseUrl = readString(matchingModel?.baseUrl) ?? selectedBaseUrl;
  const secrets = Object.values(settingsEnv ?? {}).filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  secrets.push(...Object.values(dotEnv));
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
      dotEnvCredential !== undefined ||
      settingsCredential !== undefined,
    ...(processCredential !== undefined && processCredential.length > 0
      ? { credentialSource: "process environment" as const }
      : dotEnvCredential !== undefined
        ? { credentialSource: ".env" as const }
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
  const qwenDirectory = process.env.QWEN_HOME
    ? resolve(process.env.QWEN_HOME)
    : join(homedir(), ".qwen");
  const settingsPath = join(qwenDirectory, "settings.json");
  let settings: unknown = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
  } catch {
    // Qwen will provide the actionable parse/not-found error when it launches.
  }
  let environmentFile = "";
  try {
    environmentFile = await readFile(join(qwenDirectory, ".env"), "utf8");
  } catch {
    // A Qwen .env file is optional.
  }
  const settingsSummary = summarizeQwenSettings(
    settings,
    settingsPath,
    process.env,
    environmentFile,
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
    const javascriptCli = [".js", ".mjs", ".cjs"].includes(extension);
    const batchCli = [".cmd", ".bat"].includes(extension);
    const command = javascriptCli
      ? process.execPath
      : batchCli
        ? (process.env.ComSpec ?? "cmd.exe")
        : executable;
    const args = javascriptCli
      ? [executable, "--version"]
      : batchCli
        ? ["/d", "/s", "/c", `call "${executable}" --version`]
        : ["--version"];
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 5_000,
      windowsHide: true,
      ...(batchCli ? { windowsVerbatimArguments: true } : {}),
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

function parseDotEnv(value: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u)) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    parsed[key] = parseDotEnvValue(rawValue);
  }
  return parsed;
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
