import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { DaemonClient, type SubagentConfig } from "@qwen-code/sdk";
import type { QwenRuntimeDiagnostics } from "./QwenRuntimeDiagnostics.js";

const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_PORT_PATTERN = /listening on http:\/\/127\.0\.0\.1:(\d+)/u;
const AGENT_FILE_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);

export interface QwenSubagentDiagnostics {
  readonly workspacePath: string;
  readonly childWorkingDirectory: string;
  readonly childUserProfile: string;
  readonly childHome: string;
  readonly userAgentDirectory: string;
  readonly projectAgentDirectory: string;
  readonly userAgentsDiscovered: readonly string[];
  readonly projectAgentsDiscovered: readonly string[];
  readonly builtInAgents: readonly string[] | "unavailable";
  readonly agentToolAvailable: "yes" | "no" | "unavailable";
  readonly agentRuntimeAvailable: "yes" | "no" | "unavailable";
  readonly modelVisibleAgentNames: readonly string[] | "unavailable";
  readonly runtimeAgentNames: readonly string[] | "unavailable";
  readonly error?: string;
}

export interface QwenSubagentResolution {
  readonly agents?: readonly SubagentConfig[];
  readonly diagnostics: QwenSubagentDiagnostics;
}

export interface QwenSubagentResolverOptions {
  readonly launcherPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly electronVersion?: string;
  readonly startTimeoutMs?: number;
}

export async function resolveQwenSubagents(
  runtime: QwenRuntimeDiagnostics,
  workspacePath: string,
  options: QwenSubagentResolverOptions = {},
): Promise<QwenSubagentResolution> {
  const absoluteWorkspace = resolve(workspacePath);
  const qwenDirectory = process.env.QWEN_HOME
    ? resolve(process.env.QWEN_HOME)
    : join(homedir(), ".qwen");
  const userAgentDirectory = join(qwenDirectory, "agents");
  const projectAgentDirectory = join(absoluteWorkspace, ".qwen", "agents");
  const [userAgentsDiscovered, projectAgentsDiscovered] = await Promise.all([
    inspectAgentDirectory(userAgentDirectory),
    inspectAgentDirectory(projectAgentDirectory),
  ]);
  const baseDiagnostics: QwenSubagentDiagnostics = {
    workspacePath: absoluteWorkspace,
    childWorkingDirectory: absoluteWorkspace,
    childUserProfile: process.env.USERPROFILE ?? "unavailable",
    childHome: process.env.HOME ?? "unavailable",
    userAgentDirectory,
    projectAgentDirectory,
    userAgentsDiscovered,
    projectAgentsDiscovered,
    builtInAgents: "unavailable",
    agentToolAvailable: "unavailable",
    agentRuntimeAvailable: "unavailable",
    modelVisibleAgentNames: "unavailable",
    runtimeAgentNames: "unavailable",
  };

  let daemon: DaemonProcess | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await startQwenDaemon(runtime.cliExecutable, absoluteWorkspace, {
      ...options,
    });
    client = new DaemonClient({
      baseUrl: daemon.baseUrl,
      fetchTimeoutMs: options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS,
    });
    const listed = await client.listWorkspaceAgents();
    const names = listed.agents.map((agent) => agent.name);
    const details = await Promise.all(
      listed.agents.map(async (agent) => {
        try {
          return await client?.getWorkspaceAgent(agent.name);
        } catch {
          return undefined;
        }
      }),
    );
    const agents = details
      .filter(
        (agent): agent is NonNullable<typeof agent> => agent !== undefined,
      )
      .map(toSessionSubagentConfig);
    const builtInAgents = listed.agents
      .filter((agent) => agent.isBuiltin)
      .map((agent) => agent.name);
    return {
      ...(agents.length === 0 ? {} : { agents }),
      diagnostics: {
        ...baseDiagnostics,
        builtInAgents,
        agentRuntimeAvailable: "yes",
        runtimeAgentNames: names,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      diagnostics: {
        ...baseDiagnostics,
        error: `Qwen agent registry discovery unavailable: ${message}`,
      },
    };
  } finally {
    client?.dispose();
    await daemon?.close();
  }
}

export function formatQwenSubagentDiagnostics(
  diagnostics: QwenSubagentDiagnostics,
): readonly string[] {
  return [
    "Subagent diagnostics:",
    `Workspace: ${diagnostics.workspacePath}`,
    `Qwen child cwd: ${diagnostics.childWorkingDirectory}`,
    `Qwen child USERPROFILE: ${diagnostics.childUserProfile}`,
    `Qwen child HOME: ${diagnostics.childHome}`,
    `User agent directory: ${diagnostics.userAgentDirectory}`,
    `Project agent directory: ${diagnostics.projectAgentDirectory}`,
    `User agents discovered: ${formatNames(diagnostics.userAgentsDiscovered)}`,
    `Project agents discovered: ${formatNames(diagnostics.projectAgentsDiscovered)}`,
    `Built-in agents: ${formatNames(diagnostics.builtInAgents)}`,
    `Agent tool available: ${diagnostics.agentToolAvailable}`,
    `Agent runtime available: ${diagnostics.agentRuntimeAvailable}`,
    `Subagent names visible to model: ${formatNames(diagnostics.modelVisibleAgentNames)}`,
    `Subagent names available to runtime: ${formatNames(diagnostics.runtimeAgentNames)}`,
    ...(diagnostics.error === undefined ? [] : [diagnostics.error]),
  ];
}

function formatNames(names: readonly string[] | "unavailable"): string {
  return names === "unavailable"
    ? "unavailable"
    : names.length === 0
      ? "none"
      : names.join(", ");
}

function toSessionSubagentConfig(
  agent: Awaited<ReturnType<DaemonClient["getWorkspaceAgent"]>>,
): SubagentConfig {
  return {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    level: "session",
    ...(agent.tools === undefined ? {} : { tools: agent.tools }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.runConfig === undefined ? {} : { runConfig: agent.runConfig }),
    ...(agent.color === undefined ? {} : { color: agent.color }),
    ...(agent.isBuiltin ? { isBuiltin: true } : {}),
  };
}

async function inspectAgentDirectory(
  directory: string,
): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && AGENT_FILE_EXTENSIONS.has(extname(entry.name)),
        )
        .map(async (entry) => {
          try {
            const content = await readFile(join(directory, entry.name), "utf8");
            const name = /^name:\s*([^\r\n#]+)\s*$/mu
              .exec(content)?.[1]
              ?.trim();
            return name === undefined || name.length === 0 ? undefined : name;
          } catch {
            return undefined;
          }
        }),
    );
    return names
      .filter((name): name is string => name !== undefined)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

interface DaemonProcess {
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface DaemonLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly buildArgs?: (daemonArgs: readonly string[]) => readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

async function startQwenDaemon(
  executable: string,
  workspacePath: string,
  options: QwenSubagentResolverOptions,
): Promise<DaemonProcess> {
  const launch = resolveDaemonLaunch(executable, options);
  const daemonArgs = [
    "serve",
    "--port",
    "0",
    "--no-web",
    "--workspace",
    workspacePath,
  ];
  const child = spawn(
    launch.command,
    launch.buildArgs === undefined
      ? [...launch.args, ...daemonArgs]
      : [...launch.buildArgs(daemonArgs)],
    {
      cwd: workspacePath,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(launch.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
      windowsHide: true,
    },
  );
  let output = "";
  let errorOutput = "";
  const onStdout = (chunk: Buffer) => {
    output += chunk.toString();
  };
  const onStderr = (chunk: Buffer) => {
    errorOutput += chunk.toString();
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `daemon did not announce a listening port within ${String(options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS)}ms`,
          ),
        );
      }, options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS);
      const check = () => {
        const match = DAEMON_PORT_PATTERN.exec(output);
        if (match?.[1] !== undefined) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      };
      child.stdout.on("data", check);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `daemon exited with code ${String(code)}${errorOutput.trim().length === 0 ? "" : `: ${errorOutput.trim().slice(-500)}`}`,
          ),
        );
      });
      check();
    });
    return {
      baseUrl: `http://127.0.0.1:${String(port)}`,
      close: () => closeChild(child),
    };
  } catch (error) {
    await closeChild(child);
    throw error;
  } finally {
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
  }
}

async function closeChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveClose) => {
    child.once("exit", () => resolveClose());
  });
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolveTaskKill) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      const timeout = setTimeout(resolveTaskKill, 2_000);
      killer.once("close", () => {
        clearTimeout(timeout);
        resolveTaskKill();
      });
      killer.once("error", () => {
        clearTimeout(timeout);
        resolveTaskKill();
      });
    });
  } else {
    child.kill();
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  await Promise.race([
    exited,
    new Promise<void>((resolveClose) => setTimeout(resolveClose, 2_000)),
  ]);
}

function resolveDaemonLaunch(
  executable: string,
  options: QwenSubagentResolverOptions,
): DaemonLaunch {
  const platform = options.platform ?? process.platform;
  const electronVersion = options.electronVersion ?? process.versions.electron;
  const extension = extname(executable).toLowerCase();
  const javascriptCli = [".js", ".mjs", ".cjs"].includes(extension);
  if (platform === "win32" && electronVersion !== undefined && javascriptCli) {
    const launcherPath =
      options.launcherPath ??
      join(
        typeof __dirname === "string" ? __dirname : process.cwd(),
        "qwen-cli-launcher.mjs",
      );
    return {
      command: launcherPath,
      args: [],
      env: {
        ...process.env,
        QWEN_FRONTEND_CLI_TARGET: executable,
      },
    };
  }
  if (platform === "win32" && [".cmd", ".bat"].includes(extension)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: [],
      env: { ...process.env },
      buildArgs: (daemonArgs) => [
        "/d",
        "/s",
        "/c",
        `call "${executable}" ${daemonArgs
          .map((argument) => quoteCommandArgument(argument))
          .join(" ")}`,
      ],
      windowsVerbatimArguments: true,
    };
  }
  if (javascriptCli) {
    return {
      command: process.execPath,
      args: [executable],
      env: { ...process.env },
    };
  }
  return { command: executable, args: [], env: { ...process.env } };
}

function quoteCommandArgument(argument: string): string {
  return /[\s"&|<>^]/u.test(argument)
    ? `"${argument.replaceAll('"', '\\"')}"`
    : argument;
}
