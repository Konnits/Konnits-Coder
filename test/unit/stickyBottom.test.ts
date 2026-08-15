import { describe, expect, it } from "vitest";
import {
  distanceFromBottom,
  StickyBottomController,
} from "../../webview/src/stickyBottom.js";

describe("sticky bottom controller", () => {
  it("stays in follow mode at the bottom across growth and collapse", () => {
    const controller = new StickyBottomController(80);
    expect(controller.observeUserScroll(metrics(1_000, 600, 400))).toBe(true);
    expect(controller.shouldAnchorAfterLayoutChange()).toBe(true);
    expect(controller.shouldAnchorAfterLayoutChange()).toBe(true);
  });

  it("disables follow when the user reviews history and does not force layout jumps", () => {
    const controller = new StickyBottomController(80);
    expect(controller.observeUserScroll(metrics(1_000, 300, 400))).toBe(false);
    expect(controller.shouldAnchorAfterLayoutChange()).toBe(false);
  });

  it("re-enables follow when the user returns near the bottom", () => {
    const controller = new StickyBottomController(80);
    controller.observeUserScroll(metrics(1_000, 200, 400));
    expect(controller.observeUserScroll(metrics(1_000, 530, 400))).toBe(true);
  });

  it("supports an explicit jump to latest", () => {
    const controller = new StickyBottomController();
    controller.observeUserScroll(metrics(2_000, 100, 500));
    controller.jumpToLatest();
    expect(controller.isFollowing()).toBe(true);
  });

  it("clamps negative bottom distance caused by browser rounding", () => {
    expect(distanceFromBottom(metrics(999, 600, 400))).toBe(0);
  });
});

function metrics(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
) {
  return { scrollHeight, scrollTop, clientHeight };
}
