import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  isInsecureRemoteBaseUrl,
  normalizeOpenAIBaseUrl,
  QwenSettingsError,
  QwenSettingsService,
  resolveGlobalQwenDirectory,
} from "../../src/models/QwenSettingsService.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("QwenSettingsService", () => {
  it("resolves QWEN_HOME before the cross-platform home default", () => {
    expect(resolveGlobalQwenDirectory(" ./custom-qwen ", "C:/Users/me")).toBe(
      path.resolve("./custom-qwen"),
    );
    expect(resolveGlobalQwenDirectory(undefined, "C:/Users/me")).toBe(
      path.join("C:/Users/me", ".qwen"),
    );
  });

  it("enumerates provider arrays without exposing credentials", async () => {
    const fixture = await createFixture({
      modelProviders: {
        openai: [
          {
            id: "local-model",
            name: "Local Model",
            baseUrl: "http://localhost:1234/v1/",
            envKey: "LOCAL_TOKEN",
            generationConfig: {
              contextWindowSize: 131_072,
              reasoning: { effort: "high" },
            },
          },
        ],
      },
      env: { LOCAL_TOKEN: "settings-secret" },
    });
    const snapshot = await fixture.service.load();

    expect(snapshot.catalog.models).toEqual([
      expect.objectContaining({
        id: "local-model",
        displayName: "Local Model",
        baseUrl: "http://localhost:1234/v1",
        contextWindowSize: 131_072,
        reasoning: { effort: "high" },
        credentialConfigured: true,
      }),
    ]);
    expect(JSON.stringify(snapshot.catalog)).not.toContain("settings-secret");
    expect(JSON.stringify(snapshot.catalog)).not.toContain("LOCAL_TOKEN");
  });

  it("keeps the same model ID at different endpoints distinct", async () => {
    const fixture = await createFixture({
      modelProviders: {
        openai: [
          {
            id: "qwen",
            name: "Computer A",
            baseUrl: "http://127.0.0.1:1234/v1",
          },
          {
            id: "qwen",
            name: "Computer B",
            baseUrl: "http://192.168.1.20:1234/v1",
          },
        ],
      },
    });
    const models = (await fixture.service.load()).catalog.models;
    expect(models).toHaveLength(2);
    expect(models[0]?.key).not.toBe(models[1]?.key);
  });

  it("selects by auth type, model ID, and base URL while preserving unrelated settings", async () => {
    const fixture = await createFixture({
      custom: { untouched: true },
      model: { maxToolCallsPerTurn: 0, name: "old" },
      security: { auth: { extra: "keep" }, other: 12 },
      modelProviders: {
        openai: [
          {
            id: "qwen",
            name: "Remote",
            baseUrl: "http://192.168.1.20:1234/v1",
          },
        ],
      },
    });
    const snapshot = await fixture.service.load();
    await fixture.service.selectModel(
      snapshot,
      snapshot.catalog.models[0]!.key,
    );
    const saved = await readJson(fixture.settingsPath);

    expect(saved.custom).toEqual({ untouched: true });
    expect(saved.model).toEqual({
      maxToolCallsPerTurn: 0,
      name: "qwen",
      baseUrl: "http://192.168.1.20:1234/v1",
    });
    expect(saved.security).toEqual({
      auth: { extra: "keep", selectedType: "openai" },
      other: 12,
    });
  });

  it("detects the active duplicate using the persisted base URL", async () => {
    const fixture = await createFixture({
      model: { name: "qwen", baseUrl: "http://computer-b:1234/v1/" },
      security: { auth: { selectedType: "openai" } },
      modelProviders: {
        openai: [
          { id: "qwen", name: "A", baseUrl: "http://computer-a:1234/v1" },
          { id: "qwen", name: "B", baseUrl: "http://computer-b:1234/v1" },
        ],
      },
    });
    expect((await fixture.service.load()).catalog.active?.displayName).toBe(
      "B",
    );
  });

  it("refuses to overwrite invalid JSON", async () => {
    const fixture = await createFixtureRaw("{ invalid json");
    await expect(fixture.service.load()).rejects.toMatchObject({
      kind: "invalid-json",
    });
    expect(await fs.readFile(fixture.settingsPath, "utf8")).toBe(
      "{ invalid json",
    );
  });

  it("uses an atomic replacement and creates only one original backup", async () => {
    const fixture = await createFixture({
      marker: "original",
      modelProviders: {
        openai: [{ id: "one", baseUrl: "http://localhost:1/v1" }],
      },
    });
    let snapshot = await fixture.service.load();
    snapshot = await fixture.service.selectModel(
      snapshot,
      snapshot.catalog.models[0]!.key,
    );
    await fixture.service.selectModel(
      snapshot,
      snapshot.catalog.models[0]!.key,
    );

    const backup = await readJson(`${fixture.settingsPath}.konnits-backup`);
    expect(backup.marker).toBe("original");
    expect(
      (await fs.readdir(fixture.qwenHome)).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
    await expect(readJson(fixture.settingsPath)).resolves.toBeDefined();
  });

  it("detects a concurrent settings modification before writing", async () => {
    const fixture = await createFixture({
      modelProviders: {
        openai: [{ id: "one", baseUrl: "http://localhost:1/v1" }],
      },
    });
    const snapshot = await fixture.service.load();
    await fs.writeFile(fixture.settingsPath, '{"external":true}\n', "utf8");

    await expect(
      fixture.service.selectModel(snapshot, snapshot.catalog.models[0]!.key),
    ).rejects.toMatchObject({ kind: "concurrent-modification" });
    expect(await readJson(fixture.settingsPath)).toEqual({ external: true });
  });

  it("stores a new token only in .env and references it through envKey", async () => {
    const fixture = await createFixture({ keep: "value" });
    const token = "super-secret-token";
    const result = await fixture.service.upsertOpenAIModel(
      await fixture.service.load(),
      {
        displayName: "Remote Qwen",
        id: "qwen-model",
        baseUrl: "http://192.168.1.20:1234/v1/",
        contextWindowSize: 262_144,
        reasoning: false,
        token,
      },
    );
    const settingsRaw = await fs.readFile(fixture.settingsPath, "utf8");
    const environmentRaw = await fs.readFile(
      path.join(fixture.qwenHome, ".env"),
      "utf8",
    );

    expect(settingsRaw).not.toContain(token);
    expect(environmentRaw).toContain(token);
    expect(JSON.stringify(result.snapshot.catalog)).not.toContain(token);
    expect(result.snapshot.catalog.models[0]).toMatchObject({
      contextWindowSize: 262_144,
      reasoning: false,
      credentialConfigured: true,
    });
  });

  it("preserves unknown provider and generation fields when editing", async () => {
    const fixture = await createFixture({
      modelProviders: {
        openai: [
          {
            id: "old-id",
            name: "Old",
            baseUrl: "http://localhost:1234/v1",
            envKey: "KEEP_KEY",
            providerExtra: { untouched: true },
            generationConfig: {
              maxRetries: 7,
              extra_body: { custom: true },
            },
          },
        ],
      },
    });
    const snapshot = await fixture.service.load();
    await fixture.service.upsertOpenAIModel(
      snapshot,
      {
        displayName: "Renamed",
        id: "old-id",
        baseUrl: "http://localhost:1234/v1",
        contextWindowSize: 65_536,
        reasoning: { effort: "medium" },
      },
      snapshot.catalog.models[0]!.key,
    );
    const saved = await readJson(fixture.settingsPath);
    const entry = (
      saved.modelProviders as { openai: Record<string, unknown>[] }
    ).openai[0];
    expect(entry).toMatchObject({
      name: "Renamed",
      envKey: "KEEP_KEY",
      providerExtra: { untouched: true },
      generationConfig: {
        maxRetries: 7,
        extra_body: { custom: true },
        contextWindowSize: 65_536,
        reasoning: { effort: "medium" },
      },
    });
  });

  it("detects a concurrent .env modification before adding a credential", async () => {
    const fixture = await createFixture({});
    const environmentPath = path.join(fixture.qwenHome, ".env");
    await fs.writeFile(environmentPath, "EXISTING=one\n", "utf8");
    const snapshot = await fixture.service.load();
    await fs.writeFile(environmentPath, "EXISTING=changed\n", "utf8");

    await expect(
      fixture.service.upsertOpenAIModel(snapshot, {
        displayName: "Remote",
        id: "remote",
        baseUrl: "https://models.example/v1",
        token: "secret",
      }),
    ).rejects.toMatchObject({ kind: "concurrent-modification" });
    expect(await fs.readFile(environmentPath, "utf8")).toBe(
      "EXISTING=changed\n",
    );
  });

  it("warns and blocks writes when workspace modelProviders override user settings", async () => {
    const fixture = await createFixture({
      modelProviders: {
        openai: [{ id: "user", baseUrl: "http://localhost/v1" }],
      },
    });
    const workspace = path.join(fixture.root, "workspace");
    await fs.mkdir(path.join(workspace, ".qwen"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".qwen", "settings.json"),
      '{"modelProviders":{"openai":[]}}\n',
      "utf8",
    );
    const snapshot = await fixture.service.load(workspace);
    expect(snapshot.catalog.workspaceOverride?.path).toContain("settings.json");
    await expect(
      fixture.service.selectModel(snapshot, snapshot.catalog.models[0]!.key),
    ).rejects.toMatchObject({ kind: "workspace-override" });
  });

  it("rejects exact provider duplicates but permits the same ID at another URL", async () => {
    const fixture = await createFixture({
      modelProviders: {
        openai: [{ id: "qwen", baseUrl: "http://one:1234/v1" }],
      },
    });
    const snapshot = await fixture.service.load();
    await expect(
      fixture.service.upsertOpenAIModel(snapshot, {
        displayName: "Duplicate",
        id: "qwen",
        baseUrl: "http://one:1234/v1/",
      }),
    ).rejects.toBeInstanceOf(QwenSettingsError);
    await expect(
      fixture.service.upsertOpenAIModel(snapshot, {
        displayName: "Second",
        id: "qwen",
        baseUrl: "http://two:1234/v1",
      }),
    ).resolves.toBeDefined();
  });
});

describe("OpenAI-compatible URL handling", () => {
  it("normalizes trailing slashes and rejects embedded credentials", () => {
    expect(normalizeOpenAIBaseUrl(" HTTP://Example.COM:1234/v1/// ")).toBe(
      "http://example.com:1234/v1",
    );
    expect(() =>
      normalizeOpenAIBaseUrl("https://token@example.com/v1"),
    ).toThrow(/credentials/iu);
  });

  it("warns only for unencrypted non-loopback endpoints", () => {
    expect(isInsecureRemoteBaseUrl("http://localhost:1234/v1")).toBe(false);
    expect(isInsecureRemoteBaseUrl("http://127.0.0.2:1234/v1")).toBe(false);
    expect(isInsecureRemoteBaseUrl("http://192.168.1.20:1234/v1")).toBe(true);
    expect(isInsecureRemoteBaseUrl("https://models.example/v1")).toBe(false);
  });
});

async function createFixture(settings: Record<string, unknown>) {
  return createFixtureRaw(
    `${JSON.stringify({ $version: 4, ...settings }, undefined, 2)}\n`,
  );
}

async function createFixtureRaw(raw: string) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "konnits-model-test-"));
  temporaryDirectories.push(root);
  const qwenHome = path.join(root, "qwen-home");
  await fs.mkdir(qwenHome, { recursive: true });
  const settingsPath = path.join(qwenHome, "settings.json");
  await fs.writeFile(settingsPath, raw, "utf8");
  return {
    root,
    qwenHome,
    settingsPath,
    service: new QwenSettingsService({ QWEN_HOME: qwenHome }, () => root),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}
