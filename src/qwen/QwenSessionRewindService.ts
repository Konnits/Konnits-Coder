import { DaemonClient, type DaemonRewindSnapshotInfo } from "@qwen-code/sdk";
import { resolve } from "node:path";
import {
  inspectQwenRuntime,
  type QwenRuntimeDiagnostics,
} from "./QwenRuntimeDiagnostics.js";
import {
  startQwenDaemon,
  type QwenDaemonProcess,
} from "./QwenSubagentRegistry.js";

export interface SessionRewindRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly targetTurnIndex: number;
}

export interface SessionRewind {
  rewind(request: SessionRewindRequest): Promise<void>;
}

export interface QwenSessionRewindConfiguration {
  readonly executablePath?: string;
}

interface RewindDaemonClient {
  loadSession(
    sessionId: string,
    request: { readonly workspaceCwd: string },
  ): Promise<unknown>;
  getRewindSnapshots(sessionId: string): Promise<{
    readonly snapshots: readonly DaemonRewindSnapshotInfo[];
  }>;
  rewindSession(
    sessionId: string,
    promptId: string,
    options: { readonly rewindFiles: false },
  ): Promise<{
    readonly rewound: boolean;
    readonly targetTurnIndex: number;
  }>;
  dispose(): void;
}

export class QwenSessionRewindService implements SessionRewind {
  constructor(
    private readonly configuration: () => QwenSessionRewindConfiguration,
    private readonly runtimeResolver: (
      configuredPath?: string,
    ) => Promise<QwenRuntimeDiagnostics> = inspectQwenRuntime,
    private readonly daemonStarter: (
      executable: string,
      workspacePath: string,
    ) => Promise<QwenDaemonProcess> = (executable, workspacePath) =>
      startQwenDaemon(executable, workspacePath, {}),
    private readonly clientFactory: (baseUrl: string) => RewindDaemonClient = (
      baseUrl,
    ) =>
      new DaemonClient({
        baseUrl,
        fetchTimeoutMs: 15_000,
      }),
  ) {}

  async rewind(request: SessionRewindRequest): Promise<void> {
    if (
      !Number.isInteger(request.targetTurnIndex) ||
      request.targetTurnIndex < 0
    ) {
      throw new Error("The requested Qwen turn cannot be rewound.");
    }
    const workspacePath = resolve(request.workspacePath);
    const runtime = await this.runtimeResolver(
      this.configuration().executablePath,
    );
    let daemon: QwenDaemonProcess | undefined;
    let client: RewindDaemonClient | undefined;
    try {
      daemon = await this.daemonStarter(runtime.cliExecutable, workspacePath);
      client = this.clientFactory(daemon.baseUrl);
      await client.loadSession(request.sessionId, {
        workspaceCwd: workspacePath,
      });
      const available = await client.getRewindSnapshots(request.sessionId);
      const target = available.snapshots.find(
        (snapshot) => snapshot.turnIndex === request.targetTurnIndex,
      );
      if (target === undefined) {
        throw new Error(
          "Qwen can no longer rewind to that prompt. Its context may have been compacted.",
        );
      }
      const result = await client.rewindSession(
        request.sessionId,
        target.promptId,
        { rewindFiles: false },
      );
      if (
        !result.rewound ||
        result.targetTurnIndex !== request.targetTurnIndex
      ) {
        throw new Error(
          "Qwen did not confirm the requested conversation rewind.",
        );
      }
    } finally {
      client?.dispose();
      await daemon?.close();
    }
  }
}
