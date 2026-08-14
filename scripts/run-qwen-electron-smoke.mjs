import { spawn } from "node:child_process";
import { join } from "node:path";

if (process.platform !== "win32") {
  throw new Error("The Electron launch regression is Windows-specific.");
}

const codeExecutable =
  process.env.VSCODE_EXECUTABLE ??
  join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "Microsoft VS Code",
    "Code.exe",
  );
const child = spawn(codeExecutable, ["scripts/qwen-electron-smoke.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
  windowsHide: true,
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
process.exitCode = exitCode;
