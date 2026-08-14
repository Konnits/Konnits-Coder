import { describe, expect, it, vi } from "vitest";
import {
  EndpointProbeError,
  OpenAICompatibleEndpointProbe,
} from "../../src/models/OpenAICompatibleEndpointProbe.js";

describe("OpenAICompatibleEndpointProbe", () => {
  it("discovers models and sends an optional bearer token", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: "qwen" }, { id: "other" }] }),
    );
    const result = await new OpenAICompatibleEndpointProbe(request).test(
      "http://computer-b:1234/v1/",
      "qwen",
      "secret-token",
    );

    expect(result).toEqual({
      baseUrl: "http://computer-b:1234/v1",
      modelIds: ["qwen", "other"],
      requestedModelFound: true,
    });
    expect(request).toHaveBeenCalledWith(
      "http://computer-b:1234/v1/models",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-token",
        },
      }),
    );
  });

  it("reports successful discovery when the requested model is missing", async () => {
    const result = await new OpenAICompatibleEndpointProbe(async () =>
      jsonResponse({ data: [{ id: "different" }] }),
    ).test("https://models.example/v1", "requested");
    expect(result.requestedModelFound).toBe(false);
    expect(result.modelIds).toEqual(["different"]);
  });

  it.each([401, 403])(
    "classifies HTTP %s as an authentication failure",
    async (status) => {
      const probe = new OpenAICompatibleEndpointProbe(
        async () => new Response("unauthorized", { status }),
      );
      await expect(
        probe.test("https://models.example/v1", "qwen", "hidden"),
      ).rejects.toMatchObject({
        kind: "authentication",
      });
    },
  );

  it("reports refused connections without including the token", async () => {
    const probe = new OpenAICompatibleEndpointProbe(async () => {
      throw new Error("ECONNREFUSED secret-token");
    });
    let captured: unknown;
    try {
      await probe.test("http://computer-b:1234/v1", "qwen", "secret-token");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(EndpointProbeError);
    expect(String(captured)).toContain("Unable to connect");
    expect(String(captured)).not.toContain("secret-token");
  });

  it("times out an endpoint with an actionable message", async () => {
    const probe = new OpenAICompatibleEndpointProbe(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      5,
    );
    await expect(
      probe.test("http://computer-b:1234/v1", "qwen"),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects malformed OpenAI model-list responses", async () => {
    const probe = new OpenAICompatibleEndpointProbe(async () =>
      jsonResponse({ models: [] }),
    );
    await expect(
      probe.test("https://models.example/v1", "qwen"),
    ).rejects.toMatchObject({ kind: "response" });
  });

  it("reports non-authentication HTTP failures", async () => {
    const probe = new OpenAICompatibleEndpointProbe(
      async () => new Response("bad gateway", { status: 502 }),
    );
    await expect(
      probe.test("https://models.example/v1", "qwen"),
    ).rejects.toMatchObject({ kind: "http" });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
