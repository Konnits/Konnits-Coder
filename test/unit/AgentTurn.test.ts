import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentTurn } from "../../webview/src/AgentTurn.js";

describe("AgentTurn", () => {
  it("renders an enabled retry action for a completed user prompt", () => {
    const html = renderToStaticMarkup(
      createElement(AgentTurn, {
        turn: {
          type: "turn",
          id: "user-1",
          user: { type: "user", id: "user-1", text: "Run the tests" },
          activities: [],
          segments: [],
          errors: [],
          status: "completed",
        },
        canRetry: true,
        onRetry: vi.fn(),
        onEdit: vi.fn(),
        onRestoreFiles: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="Retry this prompt"');
    expect(html).not.toContain("disabled");
  });

  it("shows edit and file restore actions only when the prompt exposes checkpoints", () => {
    const html = renderToStaticMarkup(
      createElement(AgentTurn, {
        turn: {
          type: "turn",
          id: "user-1",
          user: {
            type: "user",
            id: "user-1",
            text: "Change files",
            canEdit: true,
            canRestoreFiles: true,
          },
          activities: [],
          segments: [],
          errors: [],
          status: "completed",
        },
        canRetry: true,
        onRetry: vi.fn(),
        onEdit: vi.fn(),
        onRestoreFiles: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="Edit this prompt"');
    expect(html).toContain('aria-label="Restore files to before this prompt"');
  });

  it("renders direct Qwen text between separate processing disclosures", () => {
    const firstTool = {
      type: "tool" as const,
      id: "tool-1",
      kind: "read" as const,
      title: "Read first.ts",
      state: "succeeded" as const,
    };
    const secondTool = {
      type: "tool" as const,
      id: "tool-2",
      kind: "edit" as const,
      title: "Edit second.ts",
      state: "running" as const,
    };
    const message = {
      type: "assistant" as const,
      id: "message-1",
      text: "I found the relevant file.",
      complete: true,
    };
    const html = renderToStaticMarkup(
      createElement(AgentTurn, {
        turn: {
          type: "turn",
          id: "user-1",
          user: { type: "user", id: "user-1", text: "Inspect" },
          activities: [firstTool, message, secondTool],
          segments: [
            {
              type: "processing",
              id: "processing-1",
              activities: [firstTool],
              status: "completed",
            },
            { type: "assistant", id: message.id, item: message },
            {
              type: "processing",
              id: "processing-2",
              activities: [secondTool],
              status: "working",
            },
          ],
          errors: [],
          status: "working",
        },
        canRetry: false,
        onRetry: vi.fn(),
        onEdit: vi.fn(),
        onRestoreFiles: vi.fn(),
        onOpenLink: vi.fn(),
      }),
    );

    const firstProcessing = html.indexOf("Read first.ts");
    const directMessage = html.indexOf("I found the relevant file.");
    const secondProcessing = html.indexOf("Edit second.ts");
    expect(firstProcessing).toBeGreaterThan(-1);
    expect(directMessage).toBeGreaterThan(firstProcessing);
    expect(secondProcessing).toBeGreaterThan(directMessage);
  });
});
