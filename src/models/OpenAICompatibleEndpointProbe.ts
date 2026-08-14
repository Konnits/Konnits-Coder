import { normalizeOpenAIBaseUrl } from "./QwenSettingsService.js";

export interface EndpointProbeResult {
  readonly baseUrl: string;
  readonly modelIds: readonly string[];
  readonly requestedModelFound: boolean;
}

export class EndpointProbeError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "authentication"
      | "http"
      | "network"
      | "timeout"
      | "response",
  ) {
    super(message);
    this.name = "EndpointProbeError";
  }
}

export class OpenAICompatibleEndpointProbe {
  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMilliseconds = 8_000,
  ) {}

  async test(
    baseUrl: string,
    modelId: string,
    token?: string,
  ): Promise<EndpointProbeResult> {
    const normalized = normalizeOpenAIBaseUrl(baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMilliseconds,
    );
    let response: Response;
    try {
      response = await this.fetchImplementation(`${normalized}/models`, {
        method: "GET",
        headers:
          token === undefined || token.length === 0
            ? { Accept: "application/json" }
            : { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new EndpointProbeError(
          `Timed out connecting to ${normalized}/models after ${String(this.timeoutMilliseconds)} ms. Check that the server is reachable from this computer.`,
          "timeout",
        );
      }
      throw new EndpointProbeError(
        `Unable to connect to ${normalized}/models. Check the address, firewall, and whether the server is listening for remote connections.`,
        "network",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new EndpointProbeError(
          `Authentication failed for ${normalized}/models (HTTP ${String(response.status)}). Check the API token.`,
          "authentication",
        );
      }
      throw new EndpointProbeError(
        `The model endpoint ${normalized}/models returned HTTP ${String(response.status)} ${response.statusText || "error"}.`,
        "http",
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EndpointProbeError(
        `The model endpoint ${normalized}/models did not return valid JSON.`,
        "response",
      );
    }
    const modelIds = readModelIds(payload);
    return {
      baseUrl: normalized,
      modelIds,
      requestedModelFound: modelIds.includes(modelId),
    };
  }
}

function readModelIds(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new EndpointProbeError(
      "The server response is not an OpenAI-compatible model list (expected a data array).",
      "response",
    );
  }
  return payload.data.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" && item.id.trim().length > 0
      ? [item.id]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
