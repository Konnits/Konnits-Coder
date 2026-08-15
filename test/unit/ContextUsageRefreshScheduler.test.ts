import { describe, expect, it, vi } from "vitest";
import { ContextUsageRefreshScheduler } from "../../src/qwen/ContextUsageRefreshScheduler.js";

describe("ContextUsageRefreshScheduler", () => {
  it("debounces repeated refresh boundaries", async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn(async () => undefined);
      const scheduler = new ContextUsageRefreshScheduler(refresh, 500);
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(300);
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(499);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledOnce();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overlaps context control requests", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst: (() => void) | undefined;
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const refresh = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(() => first)
        .mockResolvedValue(undefined);
      const scheduler = new ContextUsageRefreshScheduler(refresh, 500);

      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).toHaveBeenCalledOnce();
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).toHaveBeenCalledOnce();
      finishFirst?.();
      await first;
      await vi.advanceTimersByTimeAsync(500);
      expect(refresh).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the latest scheduled boundary immediately", async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn(async () => undefined);
      const scheduler = new ContextUsageRefreshScheduler(refresh, 500);
      scheduler.schedule();
      await scheduler.flush();
      expect(refresh).toHaveBeenCalledOnce();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
