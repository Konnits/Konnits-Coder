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
          source: "Qwen runtime",
        },
        {
          name: "/git:commit",
          description: "Project commit helper",
          source: "Project command",
          aliases: ["commit"],
        },
        {
          name: "/model",
          description: "Switch the active Qwen model",
          source: "Qwen runtime",
        },
        {
          name: "/personal",
          description: "Personal helper",
          source: "User command",
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
