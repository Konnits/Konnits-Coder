import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PermissionCard } from "../../webview/src/PermissionCard.js";

describe("PermissionCard", () => {
  it("keeps approval controls visible independently of Processing expansion", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionCard, {
        permission: {
          id: "permission-1",
          toolName: "edit",
          title: "Allow Edit?",
          risk: "write",
          detail: "src/example.ts",
        },
        onDecision: vi.fn(),
      }),
    );
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("src/example.ts");
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Deny<");
    expect(html).not.toContain("processing-items");
  });
});
