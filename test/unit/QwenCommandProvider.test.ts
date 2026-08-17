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
  it("normalizes runtime metadata and gives project command metadata precedence", async () => {
    const fixture = await createFixture("metadata");
    try {
      await mkdir(join(fixture.qwenHome, "commands", "git"), {
        recursive: true,
      });
      await mkdir(join(fixture.workspace, ".qwen", "commands", "git"), {
        recursive: true,
      });
      await writeFile(
        join(fixture.qwenHome, "commands", "git", "commit.md"),
        "---\ndescription: User helper\n---\nPrompt",
      );
      await writeFile(
        join(fixture.workspace, ".qwen", "commands", "git", "commit.md"),
        "---\ndescription: Project helper\n---\nPrompt",
      );
      const activeQuery = fakeQuery({
        commands: [
          {
            name: "context",
            description: "Runtime context",
            argumentHint: "[detail]",
          },
          { name: "git:commit", _meta: { altNames: ["commit"] } },
          "future-command",
        ],
      });
      const queryFactory = vi.fn(
        () => activeQuery,
      ) as unknown as QwenCommandQueryFactory;
      const provider = providerFor(queryFactory);

      await expect(provider.discover(fixture.workspace)).resolves.toEqual([
        expect.objectContaining({
          id: "qwen:context",
          command: "/context",
          description: "Runtime context",
          usage: "/context [detail]",
          source: "qwen",
          executionMode: "qwen-sdk",
          available: true,
        }),
        expect.objectContaining({
          command: "/future-command",
          description: "Command reported by the active Qwen runtime.",
        }),
        expect.objectContaining({
          command: "/git:commit",
          description: "Project helper",
          origin: "project",
          aliases: ["/commit"],
        }),
      ]);
      expect(queryFactory).toHaveBeenCalledOnce();
      expect(activeQuery.close).toHaveBeenCalledOnce();
    } finally {
      await fixture.dispose();
    }
  });

  it("exposes custom-only commands without inventing a static Qwen catalog", async () => {
    const fixture = await createFixture("custom");
    try {
      await mkdir(join(fixture.workspace, ".qwen", "commands"), {
        recursive: true,
      });
      await writeFile(
        join(fixture.workspace, ".qwen", "commands", "review.md"),
        "---\ndescription: Review the current change\nargument-hint: [path]\n---\nPrompt",
      );
      const provider = providerFor(() => fakeQuery({ commands: ["mystery"] }));
      await expect(provider.discover(fixture.workspace)).resolves.toEqual([
        expect.objectContaining({ command: "/mystery", origin: "qwen" }),
        expect.objectContaining({
          command: "/review",
          description: "Review the current change",
          usage: "/review [path]",
          origin: "project",
        }),
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("caches a workspace snapshot until explicitly refreshed", async () => {
    const queryFactory = vi.fn(() =>
      fakeQuery({ commands: ["status"] }),
    ) as unknown as QwenCommandQueryFactory;
    const provider = providerFor(queryFactory);
    await provider.discover("C:\\workspace");
    await provider.discover("C:\\workspace");
    expect(queryFactory).toHaveBeenCalledOnce();
    provider.refresh();
    await provider.discover("C:\\workspace");
    expect(queryFactory).toHaveBeenCalledTimes(2);
  });

  it("returns an empty catalog and logs when runtime discovery fails", async () => {
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

function providerFor(
  queryFactory: QwenCommandQueryFactory,
): QwenCommandProvider {
  return new QwenCommandProvider(
    () => ({ debug: false }),
    { debug: vi.fn(), error: vi.fn() },
    queryFactory,
    async () => ({}) as never,
  );
}

async function createFixture(name: string): Promise<{
  readonly workspace: string;
  readonly qwenHome: string;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `konnits-command-${name}-`));
  const previous = process.env.QWEN_HOME;
  const qwenHome = join(root, "home");
  process.env.QWEN_HOME = qwenHome;
  return {
    workspace: join(root, "workspace"),
    qwenHome,
    dispose: async () => {
      if (previous === undefined) delete process.env.QWEN_HOME;
      else process.env.QWEN_HOME = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fakeQuery(
  value: unknown,
): Query & { readonly close: ReturnType<typeof vi.fn> } {
  return {
    initialized: Promise.resolve(),
    supportedCommands: vi.fn(async () => value),
    close: vi.fn(async () => undefined),
  } as unknown as Query & { readonly close: ReturnType<typeof vi.fn> };
}
