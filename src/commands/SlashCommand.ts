export type SlashCommandSource = "qwen" | "konnits";

export type SlashCommandOrigin =
  | "qwen"
  | "builtin"
  | "user"
  | "project"
  | "skill"
  | "mcp"
  | "extension"
  | "unknown";

export type SlashCommandExecutionMode = "qwen-sdk" | "konnits" | "unavailable";

export interface SlashCommandDescriptor {
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly description: string;
  readonly usage?: string;
  readonly aliases?: readonly string[];
  readonly source: SlashCommandSource;
  readonly origin?: SlashCommandOrigin;
  readonly executionMode: SlashCommandExecutionMode;
  readonly available: boolean;
  readonly reasonUnavailable?: string;
}

export interface ParsedSlashCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly raw: string;
}

export interface SlashCommandWorkspace {
  readonly workspacePath?: string;
  readonly workspacePaths: readonly string[];
}

export interface NativeCommandResult {
  readonly command: string;
  readonly title: string;
  readonly markdown: string;
  readonly status: "success" | "error";
}

export interface NativeCommandContext extends SlashCommandWorkspace {
  readonly commands: readonly SlashCommandDescriptor[];
}

export type NativeCommandHandler = (
  command: ParsedSlashCommand,
  context: NativeCommandContext,
) => Promise<NativeCommandResult>;

export interface NativeCommandRegistration {
  readonly descriptor: SlashCommandDescriptor;
  readonly handler: NativeCommandHandler;
}
