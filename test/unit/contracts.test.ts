import { describe, expect, it } from "vitest";
import { parseConfigurationValues } from "../../src/configuration/ConfigurationValues.js";
import { parseWebviewMessage } from "../../src/webview/messages.js";

describe("configuration parsing", () => {
  it("normalizes the optional executable path", () => {
    expect(parseConfigurationValues("   ", false)).toEqual({ debug: false });
    expect(parseConfigurationValues("  C:/qwen/cli.js  ", true)).toEqual({
      executablePath: "C:/qwen/cli.js",
      debug: true,
    });
  });
});

describe("webview message validation", () => {
  it("accepts known messages and rejects malformed payloads", () => {
    expect(
      parseWebviewMessage({ type: "sendPrompt", prompt: "hello" }),
    ).toEqual({
      type: "sendPrompt",
      prompt: "hello",
    });
    expect(parseWebviewMessage({ type: "acceptFile", id: 42 })).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openExternal",
        href: "https://example.com",
      }),
    ).toEqual({ type: "openExternal", href: "https://example.com" });
    expect(parseWebviewMessage({ type: "unknown" })).toBeUndefined();
    expect(parseWebviewMessage(null)).toBeUndefined();
  });
});
