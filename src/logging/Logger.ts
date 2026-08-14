import * as vscode from "vscode";
import { redactSensitive } from "./redaction.js";

export class Logger implements vscode.Disposable {
  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly debugEnabled: () => boolean,
  ) {}

  debug(message: string): void {
    if (this.debugEnabled()) {
      this.write("DEBUG", message);
    }
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  error(message: string, error?: unknown): void {
    this.write("ERROR", message);
    if (error instanceof Error) {
      this.write("ERROR", error.stack ?? error.message);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel.appendLine(
      `[${timestamp}] [${level}] ${redactSensitive(message)}`,
    );
  }
}
