import { describe, expect, it } from "vitest";
import {
  formatQwenSubagentDiagnostics,
  type QwenSubagentDiagnostics,
} from "../../src/qwen/QwenSubagentRegistry.js";

describe("Qwen subagent diagnostics", () => {
  it("distinguishes an empty runtime from unavailable introspection", () => {
    const diagnostics: QwenSubagentDiagnostics = {
      workspacePath: "C:\\workspace",
      childWorkingDirectory: "C:\\workspace",
      childUserProfile: "C:\\Users\\test",
      childHome: "C:\\Users\\test",
      userAgentDirectory: "C:\\Users\\test\\.qwen\\agents",
      projectAgentDirectory: "C:\\workspace\\.qwen\\agents",
      userAgentsDiscovered: [],
      projectAgentsDiscovered: [],
      builtInAgents: ["general-purpose", "Explore"],
      agentToolAvailable: "yes",
      agentRuntimeAvailable: "yes",
      modelVisibleAgentNames: ["general-purpose", "Explore"],
      runtimeAgentNames: ["general-purpose", "Explore"],
    };

    const output = formatQwenSubagentDiagnostics(diagnostics).join("\n");

    expect(output).toContain("Built-in agents: general-purpose, Explore");
    expect(output).toContain("Agent runtime available: yes");
    expect(output).not.toContain("unavailable");
  });

  it("reports unavailable categories without inventing names", () => {
    const diagnostics: QwenSubagentDiagnostics = {
      workspacePath: "C:\\workspace",
      childWorkingDirectory: "C:\\workspace",
      childUserProfile: "unavailable",
      childHome: "unavailable",
      userAgentDirectory: "C:\\Users\\test\\.qwen\\agents",
      projectAgentDirectory: "C:\\workspace\\.qwen\\agents",
      userAgentsDiscovered: [],
      projectAgentsDiscovered: [],
      builtInAgents: "unavailable",
      agentToolAvailable: "unavailable",
      agentRuntimeAvailable: "unavailable",
      modelVisibleAgentNames: "unavailable",
      runtimeAgentNames: "unavailable",
      error: "Qwen agent registry discovery unavailable",
    };

    const output = formatQwenSubagentDiagnostics(diagnostics).join("\n");

    expect(output).toContain("Built-in agents: unavailable");
    expect(output).toContain(
      "Subagent names available to runtime: unavailable",
    );
    expect(output).toContain("Qwen agent registry discovery unavailable");
  });
});
