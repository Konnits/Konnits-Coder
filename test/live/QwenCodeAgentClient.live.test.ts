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
    "recovers the same Qwen session after an in-flight interrupt",
    { timeout: 300_000 },
    async () => {
      const events: AgentEvent[] = [];
      const info: string[] = [];
      const client = new QwenCodeAgentClient(
        () => ({ debug: false }),
        new PermissionManager(),
        {
          beforeEdit: async () => undefined,
          afterEdit: async () => undefined,
          completeAll: async () => undefined,
        },
        {
          debug: () => undefined,
          info: (message) => info.push(message),
          error: () => undefined,
        },
      );
      client.onEvent((event) => events.push(event));
      const sessionId = randomUUID();

      try {
        await client.connect();
        const firstRun = client.run({
          prompt:
            "Analiza este repositorio en profundidad. Lee múltiples archivos y explica su arquitectura. No modifiques archivos.",
          workspacePath: process.cwd(),
          sessionId,
          resume: false,
        });
        await vi.waitFor(
          () =>
            expect(
              events.some(
                (event) =>
                  event.type === "thinking.chunk" ||
                  event.type === "assistant.message.chunk" ||
                  event.type === "tool.started",
              ),
            ).toBe(true),
          { timeout: 120_000 },
        );
        expect(events.some((event) => event.type === "agent.completed")).toBe(
          false,
        );

        await client.cancel();
        await firstRun;

        expect(events.some((event) => event.type === "agent.cancelled")).toBe(
          true,
        );
        const recoveryStart = events.length;
        const recoveryLogStart = info.length;
        await client.run({
          prompt: "Responde solamente: CANCEL_RECOVERY_OK.",
          workspacePath: process.cwd(),
          sessionId,
          resume: true,
        });

        const recoveryEvents = events.slice(recoveryStart);
        expect(
          recoveryEvents.some((event) => event.type === "agent.failed"),
        ).toBe(false);
        expect(
          info
            .slice(recoveryLogStart)
            .some((message) => message.includes("retrying once")),
        ).toBe(false);
        expect(
          recoveryEvents
            .filter((event) => event.type === "assistant.message.chunk")
            .map((event) => event.text)
            .join(""),
        ).toContain("CANCEL_RECOVERY_OK");
      } finally {
        await client.dispose();
      }
    },
  );

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
      expect(contexts.length).toBeGreaterThanOrEqual(3);
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
      expect(events.some((event) => event.type === "turn.usage.updated")).toBe(
        true,
      );
      expect(
        info.filter((message) => message.includes("retrying once")),
      ).toHaveLength(1);
      if (process.env.QWEN_LIVE_REPORT === "1") {
        console.info(
          JSON.stringify({
            turns: [firstTurn, secondTurn, thirdTurn].map((turn) => ({
              contextUpdates: turn.filter(
                (event) => event.type === "context.usage.updated",
              ).length,
              distinctContextValues: [
                ...new Set(
                  turn.flatMap((event) =>
                    event.type === "context.usage.updated"
                      ? [event.usage.usedTokens]
                      : [],
                  ),
                ),
              ].length,
              turnUsageUpdates: turn.filter(
                (event) => event.type === "turn.usage.updated",
              ).length,
              toolCompletions: turn.filter(
                (event) => event.type === "tool.completed",
              ).length,
            })),
          }),
        );
      }
    },
  );

  liveIt(
    "exposes real Qwen thinking and foreground subagent lifecycle",
    { timeout: 600_000 },
    async () => {
      const events: AgentEvent[] = [];
      const permissions = new PermissionManager();
      permissions.onDidChange(() => {
        for (const request of permissions.list()) {
          const toolName = request.toolName.toLowerCase();
          permissions.resolve(
            request.id,
            toolName === "agent" ||
              [
                "read_file",
                "read_many_files",
                "list_directory",
                "glob",
                "grep_search",
              ].includes(toolName)
              ? "allow"
              : "deny",
          );
        }
      });
      const client = new QwenCodeAgentClient(
        () => ({ debug: false }),
        permissions,
        {
          beforeEdit: async () => undefined,
          afterEdit: async () => undefined,
          completeAll: async () => undefined,
        },
        {
          debug: () => undefined,
          info: () => undefined,
          error: () => undefined,
        },
      );
      client.onEvent((event) => events.push(event));
      await client.connect();

      await client.run({
        prompt: "Puedes llamar a subagentes? Responde brevemente.",
        workspacePath: process.cwd(),
        sessionId: randomUUID(),
        resume: false,
      });
      const thinkingTurnEnd = events.length;
      const thinkingTurn = events.slice(0, thinkingTurnEnd);
      expect(
        thinkingTurn.some((event) => event.type === "thinking.chunk"),
      ).toBe(true);
      expect(
        thinkingTurn.some((event) => event.type === "thinking.completed"),
      ).toBe(true);

      await client.run({
        prompt:
          "Usa explícitamente un subagente general-purpose para realizar un análisis profundo de este repositorio. El agente principal no debe hacer el análisis por sí mismo. Ejecuta el subagente en primer plano (run_in_background=false). El subagente debe usar sus herramientas para leer package.json y src/extension.ts y buscar referencias a Qwen como evidencia. Espera el resultado del subagente y luego resúmelo. No modifiques archivos.",
        workspacePath: process.cwd(),
        sessionId: randomUUID(),
        resume: false,
      });
      await client.dispose();

      const subagentTurn = events.slice(thinkingTurnEnd);
      const agentStart = subagentTurn.find(
        (event) => event.type === "tool.started" && event.kind === "subagent",
      );
      expect(agentStart?.type).toBe("tool.started");
      if (agentStart?.type !== "tool.started") {
        return;
      }
      expect(agentStart.subagentName).toBe("general-purpose");
      const agentCompletionIndex = subagentTurn.findIndex(
        (event) =>
          event.type === "tool.completed" && event.callId === agentStart.callId,
      );
      const parentContinuationIndex = subagentTurn.findIndex(
        (event, index) =>
          index > agentCompletionIndex &&
          event.type === "assistant.message.chunk" &&
          event.parentId === undefined,
      );
      expect(agentCompletionIndex).toBeGreaterThanOrEqual(0);
      const childToolStarts = subagentTurn.filter(
        (event) =>
          event.type === "tool.started" &&
          event.parentId === agentStart.callId &&
          event.kind !== "subagent",
      );
      expect(
        childToolStarts.map((event) =>
          event.type === "tool.started" ? event.toolName : "",
        ),
      ).toEqual(expect.arrayContaining(["read_file"]));
      expect(
        childToolStarts.some(
          (event) =>
            event.type === "tool.started" &&
            ["grep_search", "glob", "list_directory"].includes(event.toolName),
        ),
      ).toBe(true);
      expect(parentContinuationIndex).toBeGreaterThan(agentCompletionIndex);
      expect(subagentTurn.at(-1)?.type).toBe("agent.completed");
      if (process.env.QWEN_LIVE_REPORT === "1") {
        console.info(
          JSON.stringify({
            subagentTrace: subagentTurn
              .filter(
                (event) =>
                  event.type === "tool.started" ||
                  event.type === "tool.completed" ||
                  event.type === "agent.completed",
              )
              .map((event) =>
                event.type === "tool.started"
                  ? {
                      type: event.type,
                      toolName: event.toolName,
                      kind: event.kind,
                      callId: event.callId,
                      parentId: event.parentId,
                      subagentName: event.subagentName,
                    }
                  : event.type === "tool.completed"
                    ? {
                        type: event.type,
                        toolName: event.toolName,
                        callId: event.callId,
                        parentId: event.parentId,
                        success: event.success,
                      }
                    : { type: event.type },
              ),
          }),
        );
      }
    },
  );

  liveIt(
    "executes the built-in Explore agent with child repository tools",
    { timeout: 600_000 },
    async () => {
      const events: AgentEvent[] = [];
      const permissions = new PermissionManager();
      permissions.onDidChange(() => {
        for (const request of permissions.list()) {
          const toolName = request.toolName.toLowerCase();
          permissions.resolve(
            request.id,
            toolName === "agent" ||
              [
                "read_file",
                "read_many_files",
                "list_directory",
                "glob",
                "grep_search",
              ].includes(toolName)
              ? "allow"
              : "deny",
          );
        }
      });
      const client = new QwenCodeAgentClient(
        () => ({ debug: false }),
        permissions,
        {
          beforeEdit: async () => undefined,
          afterEdit: async () => undefined,
          completeAll: async () => undefined,
        },
        {
          debug: () => undefined,
          info: () => undefined,
          error: () => undefined,
        },
      );
      client.onEvent((event) => events.push(event));
      await client.connect();
      await client.run({
        prompt:
          "Usa explícitamente el subagente Explore en primer plano (run_in_background=false) para investigar la estructura del repositorio. Debe usar herramientas de lectura y devolver los módulos principales. No modifiques archivos.",
        workspacePath: process.cwd(),
        sessionId: randomUUID(),
        resume: false,
      });
      await client.dispose();

      const agentStart = events.find(
        (event) => event.type === "tool.started" && event.kind === "subagent",
      );
      expect(agentStart?.type).toBe("tool.started");
      if (agentStart?.type !== "tool.started") {
        return;
      }
      expect(agentStart.subagentName).toBe("Explore");
      expect(
        events.some(
          (event) =>
            event.type === "tool.started" &&
            event.parentId === agentStart.callId &&
            event.kind !== "subagent",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "tool.completed" &&
            event.callId === agentStart.callId &&
            event.success,
        ),
      ).toBe(true);
      expect(events.at(-1)?.type).toBe("agent.completed");
      if (process.env.QWEN_LIVE_REPORT === "1") {
        console.info(
          JSON.stringify({
            exploreTrace: events
              .filter(
                (event) =>
                  event.type === "tool.started" ||
                  event.type === "tool.completed" ||
                  event.type === "agent.completed",
              )
              .map((event) =>
                event.type === "tool.started"
                  ? {
                      type: event.type,
                      toolName: event.toolName,
                      kind: event.kind,
                      callId: event.callId,
                      parentId: event.parentId,
                      subagentName: event.subagentName,
                    }
                  : event.type === "tool.completed"
                    ? {
                        type: event.type,
                        toolName: event.toolName,
                        callId: event.callId,
                        parentId: event.parentId,
                        success: event.success,
                      }
                    : { type: event.type },
              ),
          }),
        );
      }
    },
  );
});
