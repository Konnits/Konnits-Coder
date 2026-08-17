import { describe, expect, it } from "vitest";
import {
  parseComposerSuggestionMode,
  replaceComposerSuggestion,
} from "../../src/chat/ComposerInputParser.js";

describe("composer input intent", () => {
  it("opens command mode at the beginning and preserves the query", () => {
    expect(parseComposerSuggestionMode("/", 1)).toEqual({
      kind: "command",
      query: "",
      start: 0,
      end: 1,
    });
    expect(parseComposerSuggestionMode("/mo", 3)).toMatchObject({
      kind: "command",
      query: "mo",
    });
  });

  it("does not treat URLs, paths, or dates as slash commands", () => {
    expect(parseComposerSuggestionMode("https://example.com/", 20)).toEqual({
      kind: "none",
    });
    expect(parseComposerSuggestionMode("src/foo/bar", 11)).toEqual({
      kind: "none",
    });
    expect(parseComposerSuggestionMode("10/20", 5)).toEqual({ kind: "none" });
  });

  it("tracks a reference query at the caret and replaces only its token", () => {
    const mode = parseComposerSuggestionMode("Please inspect @Qwen", 20);
    expect(mode).toMatchObject({
      kind: "reference",
      query: "Qwen",
      start: 15,
      end: 20,
    });
    if (mode.kind !== "reference") {
      throw new Error("Expected a reference suggestion mode.");
    }
    expect(
      replaceComposerSuggestion("Please inspect @Qwen now", mode, ""),
    ).toBe("Please inspect  now");
  });

  it("only treats slash commands in the leading command position", () => {
    expect(parseComposerSuggestionMode("Read /con please", 9)).toEqual({
      kind: "none",
    });
    const mode = parseComposerSuggestionMode("  /con", 6);
    expect(mode).toMatchObject({ kind: "command", query: "con" });
    if (mode.kind === "command") {
      expect(replaceComposerSuggestion("  /con", mode, "/context")).toBe(
        "  /context",
      );
    }
  });
});
