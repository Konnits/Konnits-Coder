import { spawn } from "node:child_process";

const targetVariable = "QWEN_FRONTEND_CLI_TARGET";
const target = process.env[targetVariable];

if (target === undefined || target.length === 0) {
  throw new Error("The Qwen CLI bootstrap did not receive a target path.");
}

delete process.env.QWEN_FRONTEND_CLI_TARGET;

const nodeExecutable = process.env.QWEN_FRONTEND_NODE_EXECUTABLE ?? "node";
delete process.env.QWEN_FRONTEND_NODE_EXECUTABLE;

if (process.env.QWEN_FRONTEND_LAUNCH_DEBUG === "1") {
  process.stderr.write(
    `[QwenFrontendBootstrap] ${JSON.stringify({
      nodeExecutable,
      target,
    })}\n`,
  );
}

const child = spawn(nodeExecutable, [target, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      resolve(1);
      return;
    }
    resolve(code ?? 1);
  });
});
process.exitCode = exitCode;
