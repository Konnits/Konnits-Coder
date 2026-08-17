import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../../src/commands/SlashCommandParser.js";

describe("slash command parser", () => {
  it.each([
    ["/help", "/help", []],
    ["/agents", "/agents", []],
    ["/agents create", "/agents", ["create"]],
    ["  /agents   edit   Explore  ", "/agents", ["edit", "Explore"]],
    ["/foo arg1 arg2", "/foo", ["arg1", "arg2"]],
    ["/foo \"two words\" 'three words'", "/foo", ["two words", "three words"]],
  ])("parses %s", (input, command, args) => {
    expect(parseSlashCommand(input)).toMatchObject({ command, args });
  });

  it.each([
    "normal text",
    "text containing /help",
    "https://example.com/help",
    "src/chat/ChatController.ts",
    "/usr/local/bin/qwen",
    "```text\n/help\n```",
    "// comment",
  ])("does not parse ordinary input: %s", (input) => {
    expect(parseSlashCommand(input)).toBeUndefined();
  });

  it("normalizes command casing while preserving the raw invocation", () => {
    expect(parseSlashCommand("  /Agents LIST  ")).toEqual({
      command: "/agents",
      args: ["LIST"],
      raw: "/Agents LIST",
    });
  });
});
