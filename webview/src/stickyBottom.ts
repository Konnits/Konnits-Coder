import { useCallback, useEffect, useRef, useState } from "react";

export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(
    0,
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight,
  );
}

export class StickyBottomController {
  private following = true;

  constructor(private readonly threshold = 80) {}

  isFollowing(): boolean {
    return this.following;
  }

  observeUserScroll(metrics: ScrollMetrics): boolean {
    this.following = distanceFromBottom(metrics) <= this.threshold;
    return this.following;
  }

  shouldAnchorAfterLayoutChange(): boolean {
    return this.following;
  }

  jumpToLatest(): void {
    this.following = true;
  }
}

export function useStickyBottom(contentVersion: string): {
  readonly contentRef: React.RefObject<HTMLElement | null>;
  readonly following: boolean;
  readonly jumpToLatest: () => void;
} {
  const contentRef = useRef<HTMLElement>(null);
  const controllerRef = useRef(new StickyBottomController());
  const frameRef = useRef<number | undefined>(undefined);
  const [following, setFollowing] = useState(true);

  const metrics = useCallback(
    (): ScrollMetrics => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: window.scrollY,
      clientHeight: window.innerHeight,
    }),
    [],
  );

  const anchor = useCallback((): void => {
    if (!controllerRef.current.shouldAnchorAfterLayoutChange()) {
      return;
    }
    if (frameRef.current !== undefined) {
      window.cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = undefined;
      if (!controllerRef.current.shouldAnchorAfterLayoutChange()) {
        return;
      }
      window.scrollTo({
        top: Math.max(
          0,
          document.documentElement.scrollHeight - window.innerHeight,
        ),
        behavior: "auto",
      });
    });
  }, []);

  useEffect(() => {
    const onScroll = (): void => {
      const next = controllerRef.current.observeUserScroll(metrics());
      setFollowing(next);
      if (!next && frameRef.current !== undefined) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [metrics]);

  useEffect(() => {
    const element = contentRef.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(anchor);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor]);

  useEffect(() => {
    void contentVersion;
    anchor();
  }, [anchor, contentVersion]);

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) {
        window.cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const jumpToLatest = useCallback((): void => {
    controllerRef.current.jumpToLatest();
    setFollowing(true);
    anchor();
  }, [anchor]);

  return { contentRef, following, jumpToLatest };
}
