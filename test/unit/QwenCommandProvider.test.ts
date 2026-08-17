import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Query } from "@qwen-code/sdk";
import {
  QwenCommandProvider,
  type QwenCommandQueryFactory,
} from "../../src/qwen/QwenCommandProvider.js";

describe("Qwen command discovery", () => {
  it("normalizes runtime commands, aliases, descriptions, and custom precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "konnits-command-test-"));
    const qwenHome = join(root, "home");
    const workspace = join(root, "workspace");
    const previousQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = qwenHome;
    try {
      await mkdir(join(qwenHome, "commands", "git"), { recursive: true });
      await mkdir(join(workspace, ".qwen", "commands", "git"), {
        recursive: true,
      });
      await writeFile(
        join(qwenHome, "commands", "git", "commit.md"),
        "---\ndescription: User commit helper\n---\nPrompt",
      );
      await writeFile(
        join(workspace, ".qwen", "commands", "git", "commit.md"),
        "---\ndescription: Project commit helper\n---\nPrompt",
      );
      await writeFile(
        join(qwenHome, "commands", "personal.md"),
        "---\ndescription: Personal helper\n---\nPrompt",
      );

      const query = fakeQuery({
        commands: [
          "model",
          { name: "context", description: "Runtime context" },
          { name: "git:commit", _meta: { altNames: ["commit"] } },
          "personal",
        ],
      });
      const queryFactory = vi.fn(
        () => query,
      ) as unknown as QwenCommandQueryFactory;
      const provider = new QwenCommandProvider(
        () => ({ debug: false }),
        { debug: vi.fn(), error: vi.fn() },
        queryFactory,
        async () => ({}) as never,
      );

      const commands = await provider.discover(workspace);

      expect(commands).toEqual([
        {
          name: "/context",
          description: "Runtime context",
          usage: "/context [detail]",
          source: "builtin",
          available: true,
        },
        {
          name: "/git:commit",
          description: "Project commit helper",
          source: "project",
          available: true,
          aliases: ["commit"],
        },
        {
          name: "/model",
          description:
            "Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion).",
          usage:
            "/model [--fast|--voice|--vision] [--project|--global] [<model-id>] | <model-id> <prompt>",
          source: "builtin",
          available: true,
        },
        {
          name: "/personal",
          description: "Personal helper",
          source: "user",
          available: true,
        },
      ]);
      expect(queryFactory).toHaveBeenCalledOnce();
      expect(query.close).toHaveBeenCalledOnce();
    } finally {
      if (previousQwenHome === undefined) {
        delete process.env.QWEN_HOME;
      } else {
        process.env.QWEN_HOME = previousQwenHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps runtime usage metadata and exposes custom-only commands", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "konnits-command-metadata-test-"),
    );
    const previousQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = join(root, "home");
    try {
      const workspace = join(root, "workspace");
      await mkdir(join(workspace, ".qwen", "commands"), { recursive: true });
      await writeFile(
        join(workspace, ".qwen", "commands", "review.md"),
        "---\ndescription: Review the current change\nargument-hint: [path]\n---\nPrompt",
      );
      const query = fakeQuery({
        commands: [
          {
            name: "goal",
            argumentHint: "[<condition> | clear]",
            sourceLabel: "Built-in",
          },
          { name: "mystery" },
        ],
      });
      const provider = new QwenCommandProvider(
        () => ({ debug: false }),
        { debug: vi.fn(), error: vi.fn() },
        vi.fn(() => query) as unknown as QwenCommandQueryFactory,
        async () => ({}) as never,
      );

      await expect(provider.discover(workspace)).resolves.toEqual([
        {
          name: "/goal",
          description: "Set a goal — keep working until the condition is met",
          usage: "/goal [<condition> | clear]",
          source: "builtin",
          available: true,
        },
        {
          name: "/mystery",
          source: "qwen",
          available: true,
        },
        {
          name: "/review",
          description: "Review the current change",
          usage: "/review [path]",
          source: "project",
          available: true,
        },
      ]);
    } finally {
      if (previousQwenHome === undefined) {
        delete process.env.QWEN_HOME;
      } else {
        process.env.QWEN_HOME = previousQwenHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty catalog when runtime discovery fails", async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const provider = new QwenCommandProvider(
      () => ({ debug: false }),
      logger,
      undefined,
      async () => {
        throw new Error("runtime unavailable");
      },
    );

    await expect(provider.discover("C:\\workspace")).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("uses installed-runtime usage hints for context, resume, and tasks", async () => {
    const query = fakeQuery({ commands: ["tasks", "context", "resume"] });
    const queryFactory = vi.fn(
      () => query,
    ) as unknown as QwenCommandQueryFactory;
    const provider = new QwenCommandProvider(
      () => ({ debug: false }),
      { debug: vi.fn(), error: vi.fn() },
      queryFactory,
      async () => ({}) as never,
    );

    const commands = await provider.discover("C:\\workspace");

    expect(commands).toEqual([
      expect.objectContaining({
        name: "/context",
        usage: "/context [detail]",
      }),
      expect.objectContaining({
        name: "/resume",
        usage: "/resume [session-id]",
      }),
      expect.objectContaining({ name: "/tasks", usage: "/tasks" }),
    ]);
    expect(queryFactory).toHaveBeenCalledOnce();
    expect(query.close).toHaveBeenCalledOnce();
  });
});

function fakeQuery(value: unknown): Query & {
  readonly close: ReturnType<typeof vi.fn>;
} {
  return {
    initialized: Promise.resolve(),
    supportedCommands: vi.fn(async () => value),
    close: vi.fn(async () => undefined),
  } as unknown as Query & { readonly close: ReturnType<typeof vi.fn> };
}
