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
    expect(parseConfigurationValues("", false, true)).toEqual({
      debug: false,
      allowImageInput: true,
    });
    expect(parseConfigurationValues("", false, false, 180_000)).toEqual({
      debug: false,
      streamIdleTimeoutMs: 180_000,
    });
    expect(parseConfigurationValues("", false, false, 7_200_000)).toEqual({
      debug: false,
      streamIdleTimeoutMs: 7_200_000,
    });
    expect(parseConfigurationValues("", false, false, 0)).toEqual({
      debug: false,
      streamIdleTimeoutMs: 0,
    });
    expect(parseConfigurationValues("", false, false, 1)).toEqual({
      debug: false,
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
    expect(parseWebviewMessage({ type: "manageModels" })).toEqual({
      type: "manageModels",
    });
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
