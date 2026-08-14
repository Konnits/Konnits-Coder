import { describe, expect, it } from "vitest";
import { redactSensitive } from "../../src/logging/redaction.js";

describe("redactSensitive", () => {
  it("redacts known settings secrets and common credential formats", () => {
    const secret = "lm-secret-value";
    const output = redactSensitive(
      `raw=${secret} Authorization: Bearer abc.def apiKey=another-secret https://user:pass@example.test/v1`,
      [secret],
    );

    expect(output).not.toContain(secret);
    expect(output).not.toContain("abc.def");
    expect(output).not.toContain("another-secret");
    expect(output).not.toContain("user:pass");
    expect(output).toContain("[REDACTED]");
  });
});
