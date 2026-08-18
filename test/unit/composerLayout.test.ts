import { describe, expect, it } from "vitest";
import {
  COMPOSER_MAX_HEIGHT_PX,
  moveSuggestionHighlight,
  resizeComposerTextarea,
} from "../../webview/src/composerLayout.js";

describe("composer layout", () => {
  it("grows with its content until the maximum height", () => {
    const textarea = {
      scrollHeight: 72,
      style: { height: "", overflowY: "" },
    };

    resizeComposerTextarea(textarea);

    expect(textarea.style).toEqual({ height: "72px", overflowY: "hidden" });
  });

  it("caps tall content and enables its internal scrollbar", () => {
    const textarea = {
      scrollHeight: 400,
      style: { height: "", overflowY: "" },
    };

    resizeComposerTextarea(textarea);

    expect(textarea.style).toEqual({
      height: `${String(COMPOSER_MAX_HEIGHT_PX)}px`,
      overflowY: "auto",
    });
  });

  it("keeps suggestion keyboard navigation inside the available results", () => {
    expect(moveSuggestionHighlight(0, -1, 8)).toBe(0);
    expect(moveSuggestionHighlight(0, 1, 8)).toBe(1);
    expect(moveSuggestionHighlight(7, 1, 8)).toBe(7);
    expect(moveSuggestionHighlight(3, 1, 0)).toBe(0);
  });
});
