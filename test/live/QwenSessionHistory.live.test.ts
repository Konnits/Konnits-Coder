import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import { PermissionManager } from "../../src/permissions/PermissionManager.js";
import { QwenCodeAgentClient } from "../../src/qwen/QwenCodeAgentClient.js";
import {
  QwenSessionHistoryService,
  type QwenSavedSession,
} from "../../src/qwen/QwenSessionHistoryService.js";

const liveIt = process.env.QWEN_LIVE_TEST === "1" ? it : it.skip;

describe("Qwen session history live integration", () => {
  liveIt(
    "lists, restores, continues, clears, and deletes disposable real sessions",
    { timeout: 300_000 },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "konnits-history-live-"));
      const events: AgentEvent[] = [];
      const errors: string[] = [];
      const logger = {
        debug: () => undefined,
        info: () => undefined,
        error: (message: string) => errors.push(message),
      };
      const client = new QwenCodeAgentClient(
        () => ({ debug: false }),
        new PermissionManager(),
        {
          beforeEdit: async () => undefined,
          afterEdit: async () => undefined,
          completeAll: async () => undefined,
        },
        logger,
      );
      const history = new QwenSessionHistoryService(
        () => ({ debug: false }),
        logger,
      );
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      const disposableSessions: QwenSavedSession[] = [];
      client.onEvent((event) => events.push(event));

      try {
        await client.connect();
        await client.run({
          prompt:
            "Memoriza el identificador CHAT_A. Responde solamente CHAT_A.",
          workspacePath: workspace,
          sessionId: sessionA,
          resume: false,
        });
        await client.run({
          prompt: "Responde solamente CHAT_B.",
          workspacePath: workspace,
          sessionId: sessionB,
          resume: false,
        });

        const catalog = await history.list([workspace], sessionB);
        disposableSessions.push(...catalog);
        expect(catalog.map((session) => session.sessionId)).toEqual(
          expect.arrayContaining([sessionA, sessionB]),
        );
        const savedA = catalog.find(
          (session) => session.sessionId === sessionA,
        );
        expect(savedA).toBeDefined();
        if (savedA === undefined) {
          throw new Error(
            "Qwen did not persist the disposable CHAT_A session.",
          );
        }

        const transcript = await history.loadTranscript(savedA);
        expect(
          transcript.some(
            (item) => item.type === "user" && item.text.includes("CHAT_A"),
          ),
        ).toBe(true);
        expect(
          transcript.some(
            (item) =>
              item.type === "finalResponse" && item.text.includes("CHAT_A"),
          ),
        ).toBe(true);

        await client.restoreSession({
          sessionId: sessionA,
          workspacePath: workspace,
        });
        const continuationStart = events.length;
        await client.run({
          prompt:
            "¿Qué identificador exacto te pedí memorizar? Responde solamente con ese identificador.",
          workspacePath: workspace,
          sessionId: sessionA,
          resume: true,
        });
        const continuationEvents = events.slice(continuationStart);
        expect(
          continuationEvents.flatMap((event) =>
            event.type === "agent.failed" ? [event.message] : [],
          ),
        ).toEqual([]);
        expect(errors).toEqual([]);
        const streamedContinuation = continuationEvents
          .filter((event) => event.type === "assistant.message.chunk")
          .map((event) => event.text)
          .join("");
        const completedContinuation = [...continuationEvents]
          .reverse()
          .find((event) => event.type === "agent.completed");
        const continuation =
          streamedContinuation.length > 0
            ? streamedContinuation
            : completedContinuation?.type === "agent.completed"
              ? completedContinuation.result
              : "";
        expect(continuation).toContain("CHAT_A");

        const cleared = await history.deleteInactive([workspace], sessionB);
        expect(cleared).toEqual({ removed: [sessionA], errors: [] });
        const afterClear = await history.list([workspace], sessionB);
        expect(afterClear.map((session) => session.sessionId)).toEqual([
          sessionB,
        ]);

        await history.delete(afterClear[0]!);
        expect(await history.list([workspace])).toEqual([]);
        disposableSessions.length = 0;
      } finally {
        await client.dispose();
        for (const session of disposableSessions) {
          await history.delete(session).catch(() => undefined);
        }
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
