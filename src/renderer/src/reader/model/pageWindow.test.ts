import { describe, expect, it } from 'vitest';

import {
  isPageLive,
  livePageWindow,
  pagesInWindow,
  DEFAULT_OVERSCAN,
  MAX_LIVE_PAGES,
} from './pageWindow';

describe('live page window', () => {
  it('keeps the visible pages plus one on each side', () => {
    expect(livePageWindow({ first: 5, last: 6, pageCount: 100 })).toEqual({ from: 4, to: 7 });
    expect(DEFAULT_OVERSCAN).toBe(1);
  });

  it('does not run off either end of the document', () => {
    expect(livePageWindow({ first: 1, last: 2, pageCount: 10 })).toEqual({ from: 1, to: 3 });
    expect(livePageWindow({ first: 9, last: 10, pageCount: 10 })).toEqual({ from: 8, to: 10 });
  });

  it('mounts a single page document once', () => {
    expect(livePageWindow({ first: 1, last: 1, pageCount: 1 })).toEqual({ from: 1, to: 1 });
    expect(pagesInWindow(livePageWindow({ first: 1, last: 1, pageCount: 1 }))).toEqual([1]);
  });

  it('mounts nothing when there is no document', () => {
    const window = livePageWindow({ first: 1, last: 1, pageCount: 0 });

    expect(pagesInWindow(window)).toEqual([]);
    expect(isPageLive(window, 1)).toBe(false);
  });

  it('never exceeds the render budget, however many pages are on screen', () => {
    for (const visible of [1, 3, 6, 12, 40]) {
      const window = livePageWindow({ first: 10, last: 10 + visible - 1, pageCount: 500 });

      expect(pagesInWindow(window).length).toBeLessThanOrEqual(MAX_LIVE_PAGES);
    }
  });

  it('gives up the page behind before the page ahead when trimming', () => {
    // Six visible pages plus two overscan would be eight; the budget is seven,
    // so the overscan the reader has already passed is the one that goes.
    const window = livePageWindow({ first: 10, last: 15, pageCount: 500 });

    expect(window).toEqual({ from: 10, to: 16 });
  });

  it('keeps the pages a reader is moving towards when the visible band is huge', () => {
    const window = livePageWindow({ first: 3, last: 20, pageCount: 500 });

    expect(window.from).toBe(3);
    expect(pagesInWindow(window)).toHaveLength(MAX_LIVE_PAGES);
  });

  it('clamps a nonsensical visible range instead of producing one', () => {
    expect(livePageWindow({ first: 0, last: -5, pageCount: 4 })).toEqual({ from: 1, to: 2 });
    expect(livePageWindow({ first: 99, last: 120, pageCount: 4 })).toEqual({ from: 3, to: 4 });
  });

  it('answers whether a page is allowed to be mounted', () => {
    const window = livePageWindow({ first: 5, last: 5, pageCount: 100 });

    expect(isPageLive(window, 3)).toBe(false);
    expect(isPageLive(window, 4)).toBe(true);
    expect(isPageLive(window, 6)).toBe(true);
    expect(isPageLive(window, 7)).toBe(false);
  });

  it('lists the pages of a window in reading order', () => {
    expect(pagesInWindow({ from: 4, to: 7 })).toEqual([4, 5, 6, 7]);
    expect(pagesInWindow({ from: 4, to: 3 })).toEqual([]);
  });

  it('honours an explicit budget, as a constrained device would want', () => {
    const window = livePageWindow({
      first: 10,
      last: 12,
      pageCount: 100,
      overscan: 2,
      maxLivePages: 3,
    });

    expect(pagesInWindow(window)).toEqual([10, 11, 12]);
  });
});
