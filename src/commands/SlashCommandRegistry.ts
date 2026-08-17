import type {
  NativeCommandHandler,
  NativeCommandRegistration,
  SlashCommandDescriptor,
  SlashCommandWorkspace,
} from "./SlashCommand.js";

export interface QwenCommandDiscovery {
  discover(
    workspacePath: string,
    workspacePaths?: readonly string[],
  ): Promise<readonly SlashCommandDescriptor[]>;
  refresh(): void;
}

interface RegisteredCommand {
  readonly descriptor: SlashCommandDescriptor;
  readonly handler?: NativeCommandHandler;
  readonly priority: number;
}

export interface ResolvedSlashCommand {
  readonly descriptor: SlashCommandDescriptor;
  readonly handler?: NativeCommandHandler;
}

export class SlashCommandRegistry {
  private readonly registrations = new Map<string, RegisteredCommand>();
  private readonly snapshots = new Map<
    string,
    readonly ResolvedSlashCommand[]
  >();

  constructor(private readonly qwen: QwenCommandDiscovery) {}

  registerNative(registration: NativeCommandRegistration): void {
    this.register(registration.descriptor, 30, registration.handler);
  }

  registerUnavailable(descriptor: SlashCommandDescriptor): void {
    this.register(descriptor, 10);
  }

  async list(
    workspace: SlashCommandWorkspace,
  ): Promise<readonly SlashCommandDescriptor[]> {
    return (await this.snapshot(workspace)).map((entry) => entry.descriptor);
  }

  async resolve(
    command: string,
    workspace: SlashCommandWorkspace,
  ): Promise<ResolvedSlashCommand | undefined> {
    const normalized = normalizeCommand(command);
    return (await this.snapshot(workspace)).find(
      (entry) =>
        normalizeCommand(entry.descriptor.command) === normalized ||
        entry.descriptor.aliases?.some(
          (alias) => normalizeCommand(alias) === normalized,
        ) === true,
    );
  }

  refresh(): void {
    this.qwen.refresh();
    this.snapshots.clear();
  }

  private register(
    descriptor: SlashCommandDescriptor,
    priority: number,
    handler?: NativeCommandHandler,
  ): void {
    const key = normalizeCommand(descriptor.command);
    const current = this.registrations.get(key);
    if (current !== undefined && current.priority > priority) {
      return;
    }
    this.registrations.set(key, {
      descriptor: normalizeDescriptor(descriptor),
      ...(handler === undefined ? {} : { handler }),
      priority,
    });
    this.snapshots.clear();
  }

  private async snapshot(
    workspace: SlashCommandWorkspace,
  ): Promise<readonly ResolvedSlashCommand[]> {
    const key = workspaceKey(workspace);
    const cached = this.snapshots.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const merged = new Map<string, RegisteredCommand>(this.registrations);
    if (workspace.workspacePath !== undefined) {
      const discovered = await this.qwen.discover(
        workspace.workspacePath,
        workspace.workspacePaths,
      );
      for (const descriptor of discovered) {
        const normalized = normalizeDescriptor(descriptor);
        const commandKey = normalizeCommand(normalized.command);
        const registered = merged.get(commandKey);
        const qwenEntry: RegisteredCommand = {
          descriptor: normalized,
          priority: 20,
        };
        if (
          registered === undefined ||
          registered.priority < qwenEntry.priority
        ) {
          merged.set(commandKey, qwenEntry);
        }
      }
    }

    const result = [...merged.values()]
      .map(({ descriptor, handler }) => ({
        descriptor,
        ...(handler === undefined ? {} : { handler }),
      }))
      .sort((left, right) =>
        left.descriptor.command.localeCompare(right.descriptor.command),
      );
    this.snapshots.set(key, result);
    return result;
  }
}

function normalizeDescriptor(
  descriptor: SlashCommandDescriptor,
): SlashCommandDescriptor {
  const command = normalizeCommand(descriptor.command);
  const { aliases: rawAliases, ...base } = descriptor;
  const aliases = rawAliases
    ?.map(normalizeCommand)
    .filter(
      (alias, index, all) => alias !== command && all.indexOf(alias) === index,
    );
  return {
    ...base,
    command,
    ...(aliases !== undefined && aliases.length > 0 ? { aliases } : {}),
  };
}

function normalizeCommand(value: string): string {
  return `/${value.trim().replace(/^\/+/, "").toLowerCase()}`;
}

function workspaceKey(workspace: SlashCommandWorkspace): string {
  return `${workspace.workspacePath ?? "no-workspace"}\u0000${workspace.workspacePaths.join("\u0000")}`;
}
