import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { query } from "@qwen-code/sdk";

if (process.versions.electron === undefined) {
  throw new Error(
    "This smoke test must run with Electron in run-as-Node mode.",
  );
}

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@qwen-code/sdk");
const cliPath = join(dirname(sdkEntry), "cli", "cli.js");
const launcherPath = join(process.cwd(), "dist", "qwen-cli-launcher.mjs");
const prompt =
  process.env.QWEN_SMOKE_PROMPT ??
  "Responde exactamente: PROMPT_OK. No uses herramientas.";
const sessionId = process.env.QWEN_SMOKE_SESSION_ID ?? randomUUID();
const messageTypes = [];
let toolUses = 0;
let toolResults = 0;
let promptWrittenExactly = false;
let result;
let launcherDebug;
const stdinFrames = [];

const response = query({
  prompt,
  options: {
    cwd: process.cwd(),
    sessionId,
    permissionMode: "default",
    includePartialMessages: true,
    pathToQwenExecutable: launcherPath,
    env: {
      QWEN_FRONTEND_CLI_TARGET: cliPath,
      QWEN_FRONTEND_LAUNCH_DEBUG: "1",
    },
    canUseTool: async (toolName, input) =>
      isReadOnlyTool(toolName)
        ? { behavior: "allow", updatedInput: input }
        : {
            behavior: "deny",
            message: "The live validation permits read-only tools only.",
          },
    debug: true,
    logLevel: "debug",
    stderr: (message) => {
      if (message.includes("[QwenFrontendBootstrap]")) {
        launcherDebug = message
          .slice(message.indexOf("[QwenFrontendBootstrap]"))
          .trim();
      }
      if (!message.includes("Writing to stdin")) {
        return;
      }
      const jsonStart = message.indexOf("{");
      if (jsonStart === -1) {
        return;
      }
      try {
        const frame = JSON.parse(message.slice(jsonStart));
        const content = frame.message?.content;
        stdinFrames.push({
          type: frame.type,
          requestSubtype: frame.request?.subtype,
          contentLength:
            typeof content === "string" ? content.length : undefined,
          contentIsPrompt: content === prompt,
          contentIsCliPath:
            typeof content === "string" &&
            content.replaceAll("\\", "/").toLowerCase() ===
              cliPath.replaceAll("\\", "/").toLowerCase(),
        });
        if (frame.type === "user" && frame.message?.content === prompt) {
          promptWrittenExactly = true;
        }
      } catch {
        // Ignore unrelated SDK diagnostics; never print raw frames or prompts.
      }
    },
  },
});

for await (const message of response) {
  messageTypes.push(message.type);
  for (const block of message.message?.content ?? []) {
    if (block.type === "tool_use") {
      toolUses += 1;
    } else if (block.type === "tool_result") {
      toolResults += 1;
    }
  }
  if (message.type === "result") {
    result =
      message.subtype === "success"
        ? message.result
        : `ERROR: ${message.error?.message ?? message.subtype}`;
  }
}

console.log(
  JSON.stringify({
    execPath: process.execPath,
    electron: process.versions.electron,
    sessionId,
    promptWrittenExactly,
    cliPathUsedAsPrompt: result?.includes(cliPath) ?? false,
    toolUses,
    toolResults,
    resultPresent: result !== undefined,
    launcherDebug,
    stdinFrames,
    resultPreview: result?.replace(/\s+/gu, " ").slice(0, 160),
    messageCount: messageTypes.length,
    resultMessages: messageTypes.filter((type) => type === "result").length,
  }),
);

function isReadOnlyTool(toolName) {
  return [
    "read_file",
    "read_many_files",
    "list_directory",
    "glob",
    "grep_search",
  ].includes(toolName.toLowerCase());
}
