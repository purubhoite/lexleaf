import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Where the scrolling surface is, and how big it is.
 *
 * The **DOM scroll position is the single source of truth** (ADR-017).
 * Nothing in the reader stores "the current page" as state that scrolling
 * then has to agree with: the page number, the live page window and the
 * remembered position are all derived from the offset reported here. That is
 * what makes the feedback loop the plan warned about — scroll sets page sets
 * scroll — structurally impossible rather than carefully avoided.
 *
 * Scroll events arrive far faster than frames, so the offset is sampled once
 * per animation frame.
 */

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ScrollViewport {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly scrollTop: number;
  readonly viewport: ViewportSize;
  /** Moves the surface. The resulting scroll event updates the state. */
  readonly scrollTo: (offset: number) => void;
}

export const useScrollViewport = (): ScrollViewport => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;

    if (element === null) {
      return;
    }

    let frame: number | null = null;

    const sample = (): void => {
      frame = null;
      setScrollTop(element.scrollTop);
    };

    const onScroll = (): void => {
      frame ??= window.requestAnimationFrame(sample);
    };

    const observer = new ResizeObserver(() => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
      // A resize changes which pages are visible even without scrolling.
      setScrollTop(element.scrollTop);
    });

    element.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(element);
    setViewport({ width: element.clientWidth, height: element.clientHeight });

    return (): void => {
      element.removeEventListener('scroll', onScroll);
      observer.disconnect();

      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const scrollTo = useCallback((offset: number): void => {
    const element = ref.current;

    if (element !== null) {
      element.scrollTop = Math.max(0, offset);
      // Chromium coalesces the scroll event; reading it back keeps derived
      // state correct even when no event is delivered (an offset clamped to
      // the same value, for instance).
      setScrollTop(element.scrollTop);
    }
  }, []);

  return { ref, scrollTop, viewport, scrollTo };
};
