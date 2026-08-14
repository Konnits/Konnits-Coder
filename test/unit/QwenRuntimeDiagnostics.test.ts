import { describe, expect, it } from "vitest";
import {
  formatQwenRuntimeDiagnostics,
  resolveQwenRuntimeExecutable,
  summarizeQwenSettings,
  type QwenRuntimeDiagnostics,
} from "../../src/qwen/QwenRuntimeDiagnostics.js";

const settings = {
  env: { LMSTUDIO_API_KEY: "settings-secret" },
  modelProviders: {
    openai: [
      {
        id: "local-model",
        baseUrl: "http://localhost:1234/v1",
        envKey: "LMSTUDIO_API_KEY",
        generationConfig: {
          extra_body: {
            enable_thinking: true,
            maxRetries: 3,
            contextWindowSize: 32_768,
          },
        },
      },
    ],
  },
  security: { auth: { selectedType: "openai" } },
  model: { name: "local-model", baseUrl: "http://localhost:1234/v1" },
};

describe("Qwen runtime executable resolution", () => {
  it("selects the SDK bundle unless an explicit executable is configured", () => {
    expect(
      resolveQwenRuntimeExecutable(undefined, "C:\\sdk\\dist\\index.cjs"),
    ).toEqual({
      source: "bundled",
      executable: "C:\\sdk\\dist\\cli\\cli.js",
    });
    expect(
      resolveQwenRuntimeExecutable("qwen", "C:\\sdk\\dist\\index.cjs"),
    ).toEqual({ source: "configured", executable: "qwen" });
    expect(
      resolveQwenRuntimeExecutable(
        "D:\\Qwen\\cli.js",
        "C:\\sdk\\dist\\index.cjs",
      ),
    ).toEqual({ source: "configured", executable: "D:\\Qwen\\cli.js" });
  });
});

describe("Qwen settings diagnostics", () => {
  it("detects settings.env credential materialization without exposing it", () => {
    const summary = summarizeQwenSettings(
      settings,
      "C:\\Users\\test\\.qwen\\settings.json",
      {},
    );

    expect(summary.credentialConfigured).toBe(true);
    expect(summary.credentialSource).toBe("settings.env");
    expect(summary.secrets).toContain("settings-secret");
    expect(summary.warnings[0]).toContain(
      "maxRetries, contextWindowSize must be direct generationConfig fields",
    );
  });

  it("reports process environment precedence and formats only presence", () => {
    const summary = summarizeQwenSettings(
      settings,
      "C:\\Users\\test\\.qwen\\settings.json",
      { LMSTUDIO_API_KEY: "process-secret" },
    );
    const diagnostics: QwenRuntimeDiagnostics = {
      ...summary,
      sdkVersion: "0.1.8",
      cliSource: "bundled",
      cliExecutable: "C:\\sdk\\cli.js",
      cliVersion: "0.19.10",
    };
    const output = formatQwenRuntimeDiagnostics(diagnostics).join("\n");

    expect(summary.credentialSource).toBe("process environment");
    expect(output).toContain("Credential configured: yes");
    expect(output).not.toContain("process-secret");
    expect(output).not.toContain("settings-secret");
  });

  it("detects and protects a credential stored in Qwen's .env file", () => {
    const withoutSettingsSecret = {
      ...settings,
      env: {},
    };
    const summary = summarizeQwenSettings(
      withoutSettingsSecret,
      "C:\\Users\\test\\.qwen\\settings.json",
      {},
      'LMSTUDIO_API_KEY="dotenv-secret"\n',
    );

    expect(summary.credentialConfigured).toBe(true);
    expect(summary.credentialSource).toBe(".env");
    expect(summary.secrets).toContain("dotenv-secret");
    expect(
      formatQwenRuntimeDiagnostics({
        ...summary,
        sdkVersion: "0.1.8",
        cliSource: "bundled",
        cliExecutable: "cli.js",
        cliVersion: "0.19.10",
      }).join("\n"),
    ).not.toContain("dotenv-secret");
  });
});
