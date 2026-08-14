import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import { PermissionManager } from "../../src/permissions/PermissionManager.js";
import {
  QwenCodeAgentClient,
  type QwenChangeTracker,
} from "../../src/qwen/QwenCodeAgentClient.js";

const liveIt = process.env.QWEN_LIVE_TEST === "1" ? it : it.skip;

describe("QwenCodeAgentClient live integration", () => {
  liveIt(
    "reports token metrics across a real resumed Qwen session",
    { timeout: 300_000 },
    async () => {
      const info: string[] = [];
      const errors: string[] = [];
      const events: AgentEvent[] = [];
      const changes: QwenChangeTracker = {
        beforeEdit: vi.fn(async () => undefined),
        afterEdit: vi.fn(async () => undefined),
        completeAll: vi.fn(async () => undefined),
      };
      const client = new QwenCodeAgentClient(
        () => ({ debug: false }),
        new PermissionManager(),
        changes,
        {
          debug: () => undefined,
          info: (message) => info.push(message),
          error: (message) => errors.push(message),
        },
      );
      client.onEvent((event) => events.push(event));

      await client.connect();
      const sessionId = randomUUID();
      await client.run({
        prompt: "Responde solamente: Hola.",
        workspacePath: process.cwd(),
        sessionId,
        resume: true,
      });
      const firstTurnEnd = events.length;

      await client.run({
        prompt:
          "Analiza README.md, package.json y los principales archivos de src. No modifiques nada y entrega un resumen detallado.",
        workspacePath: process.cwd(),
        sessionId,
        resume: true,
      });
      const secondTurnEnd = events.length;

      await client.run({
        prompt:
          "Como seguimiento en esta misma sesión, indica brevemente qué archivo define los scripts de npm.",
        workspacePath: process.cwd(),
        sessionId,
        resume: true,
      });
      await client.dispose();

      expect(info.join("\n")).toContain("CLI source: bundled");
      expect(info.join("\n")).toContain("Credential configured: yes");
      expect(info.join("\n")).toContain(
        "The persisted Qwen session does not exist; retrying once as a new session.",
      );
      expect(errors).toEqual([]);
      expect(events.some((event) => event.type === "agent.failed")).toBe(false);
      expect(events.some((event) => event.type === "agent.completed")).toBe(
        true,
      );
      const firstTurn = events.slice(0, firstTurnEnd);
      const secondTurn = events.slice(firstTurnEnd, secondTurnEnd);
      const thirdTurn = events.slice(secondTurnEnd);
      const streamedText = firstTurn
        .filter((event) => event.type === "assistant.message.chunk")
        .map((event) => event.text)
        .join("");
      expect(streamedText).toContain("Hola");
      expect(secondTurn.some((event) => event.type === "tool.completed")).toBe(
        true,
      );
      expect(thirdTurn.some((event) => event.type === "agent.completed")).toBe(
        true,
      );

      const contexts = events.filter(
        (event) => event.type === "context.usage.updated",
      );
      expect(contexts).toHaveLength(3);
      for (const context of contexts) {
        expect(context.sessionId).toBe(sessionId);
        expect(context.usage.usedTokens).toBeGreaterThanOrEqual(0);
        expect(context.usage.contextWindowTokens).toBeGreaterThan(0);
        expect(context.usage.usedPercentage).toBeCloseTo(
          (context.usage.usedTokens / context.usage.contextWindowTokens) * 100,
          8,
        );
      }
      const completions = events.filter(
        (event) => event.type === "agent.completed",
      );
      expect(completions).toHaveLength(3);
      for (const completion of completions) {
        expect(completion.turnUsage?.inputTokens).toBeGreaterThan(0);
        expect(completion.turnUsage?.outputTokens).toBeGreaterThan(0);
      }
      expect(
        info.filter((message) => message.includes("retrying once")),
      ).toHaveLength(1);
    },
  );
});
