export class ContextUsageRefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private stopped = false;

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly delayMs = 500,
  ) {}

  schedule(): void {
    if (this.stopped) {
      return;
    }
    this.pending = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.pending = true;
    await this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    this.clearTimer();
  }

  private async drain(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.clearTimer();
    const active = this.running;
    if (active !== undefined) {
      await active;
    }
    // Awaiting an in-flight control request permits schedule()/stop() to
    // mutate these fields even though static control-flow analysis cannot.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.stopped || !this.pending) {
      return;
    }

    this.pending = false;
    const refresh = this.refresh();
    this.running = refresh;
    try {
      await refresh;
    } finally {
      if (this.running === refresh) {
        this.running = undefined;
      }
    }
    // schedule() can queue another boundary while refresh() is awaited.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.pending) {
      await this.drain();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
