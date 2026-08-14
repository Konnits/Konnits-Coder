import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { query } from "@qwen-code/sdk";

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@qwen-code/sdk");
const sdkRoot = dirname(dirname(sdkEntry));
const sdkPackage = JSON.parse(
  await readFile(join(sdkRoot, "package.json"), "utf8"),
);
const cliPath = join(dirname(sdkEntry), "cli", "cli.js");
const settingsPath = join(
  process.env.QWEN_HOME ?? join(homedir(), ".qwen"),
  "settings.json",
);
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const secrets = Object.values(settings.env ?? {}).filter(
  (value) => typeof value === "string" && value.length > 0,
);
const provider = settings.security?.auth?.selectedType;
const model = settings.model?.name;
const providerModels = settings.modelProviders?.[provider];
const providerModel = Array.isArray(providerModels)
  ? (providerModels.find(
      (candidate) =>
        candidate.id === model && candidate.baseUrl === settings.model?.baseUrl,
    ) ?? providerModels.find((candidate) => candidate.id === model))
  : undefined;
const envKey = providerModel?.envKey;
const credentialPresent = Boolean(
  envKey && (process.env[envKey] || settings.env?.[envKey]),
);
const reproduceMissingSession = process.argv.includes("--resume-missing");
const sessionId = randomUUID();

console.log(`SDK version: ${sdkPackage.version}`);
console.log(`CLI source: bundled`);
console.log(`CLI executable: ${cliPath}`);
console.log(`Workspace: ${process.cwd()}`);
console.log(`Settings: ${settingsPath}`);
console.log(`Provider: ${provider ?? "not configured"}`);
console.log(`Model: ${model ?? "not configured"}`);
console.log(`Base URL: ${providerModel?.baseUrl ?? "not configured"}`);
console.log(`Credential configured: ${credentialPresent ? "yes" : "no"}`);
console.log(
  `Invocation: ${reproduceMissingSession ? "resume nonexistent session" : "new session"}`,
);

try {
  const response = query({
    prompt: "Reply only with the text QWEN_CONNECTION_OK. Do not use tools.",
    options: {
      cwd: process.cwd(),
      permissionMode: "default",
      includePartialMessages: true,
      ...(reproduceMissingSession ? { resume: sessionId } : { sessionId }),
      debug: true,
      logLevel: "debug",
      stderr: (message) => {
        if (!message.includes("Writing to stdin")) {
          process.stderr.write(`Qwen diagnostic: ${redact(message)}\n`);
        }
      },
    },
  });

  for await (const message of response) {
    if (message.type === "result") {
      console.log(`Result subtype: ${message.subtype}`);
      if (message.subtype === "success") {
        console.log(`Result: ${redact(message.result)}`);
      } else {
        console.log(
          `Result error: ${redact(message.error?.message ?? "unknown")}`,
        );
      }
    }
  }
} catch (error) {
  console.error(`Smoke test failed: ${redact(error?.message ?? error)}`);
  process.exitCode = 1;
}

function redact(value) {
  let result = String(value)
    .replace(/Bearer\s+[^\s,"'}]+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)["']?\s*[=:]\s*["']?)[^\s,"'}]+/giu,
      "$1[REDACTED]",
    )
    .replace(/:\/\/[^/@\s]+@/gu, "://[REDACTED]@");
  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}
