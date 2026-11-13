import { useEffect, useRef, type RefObject } from 'react';

import { gestureFactor, gestureScale, wheelNotchSteps } from './model/gestureZoom';

/**
 * Pinch to zoom, and Ctrl + wheel.
 *
 * Listens on the document's scrolling region. A wheel event with Ctrl
 * held — which is also how a trackpad pinch arrives — changes the zoom and
 * is kept from scrolling the page; every other wheel event is left
 * entirely alone.
 *
 * Movements are gathered and applied at most once every `COMMIT_INTERVAL`
 * milliseconds. Each new zoom redraws the visible pages, and a pinch sends
 * dozens of movements a second: drawing for every one of them would make
 * the gesture stutter instead of follow the fingers.
 */
const COMMIT_INTERVAL = 50;

export const useGestureZoom = (
  target: RefObject<HTMLElement | null>,
  scale: number,
  onZoom: (scale: number) => void,
  enabled: boolean,
): void => {
  const current = useRef(scale);
  const report = useRef(onZoom);

  useEffect(() => {
    current.current = scale;
    report.current = onZoom;
  }, [scale, onZoom]);

  useEffect(() => {
    const element = target.current;

    if (element === null || !enabled) {
      return undefined;
    }

    let pending = 1;
    let pendingSteps = 0;
    let timer: number | null = null;

    const commit = (): void => {
      timer = null;

      const next = gestureScale(current.current, pending, pendingSteps);

      pending = 1;
      pendingSteps = 0;

      if (next !== current.current) {
        // Kept here as well as in the effect above, so that movements
        // arriving before React has drawn build on this zoom, not the last.
        current.current = next;
        report.current(next);
      }
    };

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return;
      }

      // Without this Chromium would zoom the whole window, bar and all.
      event.preventDefault();

      const steps = wheelNotchSteps(event);

      // A notch of a mouse wheel is one per cent; a pinch follows the fingers.
      if (steps === 0) {
        pending *= gestureFactor(event);
      } else {
        pendingSteps += steps;
      }

      timer ??= window.setTimeout(commit, COMMIT_INTERVAL);
    };

    // Not passive: a passive listener is not allowed to prevent the default.
    element.addEventListener('wheel', onWheel, { passive: false });

    return (): void => {
      element.removeEventListener('wheel', onWheel);

      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [target, enabled]);
};
