/**
 * The handful of browser APIs jsdom does not implement.
 *
 * jsdom has no layout engine, so anything that measures geometry is absent
 * rather than wrong. Supplying inert stand-ins here keeps component tests
 * honest — they can exercise structure and behaviour, and they cannot
 * accidentally assert anything about geometry, because the stand-ins measure
 * nothing. Real geometry is verified in the built application
 * (docs/PDF_SPIKE_REPORT.md section 5.1 and its Milestone 2 successor).
 */

if (typeof window !== 'undefined') {
  const browser = window as Window & { ResizeObserver?: typeof ResizeObserver };

  if (typeof browser.ResizeObserver !== 'function') {
    class InertResizeObserver implements ResizeObserver {
      observe(): void {
        // No layout, so no size ever changes.
      }
      unobserve(): void {}
      disconnect(): void {}
    }

    browser.ResizeObserver = InertResizeObserver;
  }

  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = function getClientRects(): DOMRectList {
      const list: DOMRect[] = [];

      return Object.assign(list, {
        item: (index: number): DOMRect | null => list[index] ?? null,
      });
    };
  }

  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return new DOMRect(0, 0, 0, 0);
    };
  }

  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      window.setTimeout(() => {
        callback(performance.now());
      }, 0);
    window.cancelAnimationFrame = (handle: number): void => {
      window.clearTimeout(handle);
    };
  }
}
