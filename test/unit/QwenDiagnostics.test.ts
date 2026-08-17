import { describe, expect, it } from "vitest";
import {
  actionableQwenError,
  QwenDiagnosticCapture,
} from "../../src/qwen/QwenDiagnostics.js";

describe("QwenDiagnosticCapture", () => {
  it("recognizes the missing persisted-session failure used for recovery", () => {
    const capture = new QwenDiagnosticCapture();
    capture.add(
      "No saved session found with ID 00000000-0000-4000-8000-000000000000.",
    );

    expect(capture.containsMissingSession()).toBe(true);
    expect(capture.summary()).toContain("No saved session found");
  });

  it("does not retain SDK stdin diagnostics containing the user prompt", () => {
    const capture = new QwenDiagnosticCapture();

    expect(
      capture.add('Writing to stdin: {"prompt":"private user text"}'),
    ).toBeUndefined();
    expect(capture.summary()).toBeUndefined();
  });

  it("recognizes the transient Qwen extension-store lock", () => {
    const capture = new QwenDiagnosticCapture();
    capture.add(
      "Extension store is busy at C:\\Users\\test\\.qwen\\extension-store.",
    );

    expect(capture.containsExtensionStoreBusy()).toBe(true);
    expect(capture.summary()).toContain("Extension store is busy");
  });
});

describe("actionableQwenError", () => {
  it("maps authentication and generic CLI exits to concise guidance", () => {
    expect(
      actionableQwenError("CLI process exited with code 1", "401 Unauthorized"),
    ).toContain("Unable to authenticate");
    expect(actionableQwenError("CLI process exited with code 1")).toBe(
      "Qwen Code exited before starting or completing the session. See the Qwen Frontend Output for diagnostic details.",
    );
  });

  it("makes missing subagent failures actionable", () => {
    expect(
      actionableQwenError(
        'Subagent "general-purpose" not found. Available subagents:',
      ),
    ).toContain("could not load the requested subagent");
  });
});
