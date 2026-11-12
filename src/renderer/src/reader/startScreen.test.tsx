// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecentDocument } from '@shared/ipc/contracts';

import { RecentDocuments } from './RecentDocuments';
import { LOOKUP_HINT_STORAGE_KEY, useLookupHint } from './useLookupHint';

/*
 * The start screen's recent books, and the one-time tip (0.2.3).
 */

const recent = (overrides: Partial<RecentDocument> = {}): RecentDocument => ({
  id: 'doc-1',
  name: 'harbour.pdf',
  sizeBytes: 2048,
  available: true,
  lastPage: 3,
  pageCount: 12,
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const show = (recents: readonly RecentDocument[], saved?: ReadonlyMap<string, number>): void => {
  render(
    <RecentDocuments
      recents={recents}
      onOpen={vi.fn()}
      onForget={vi.fn()}
      {...(saved === undefined ? {} : { savedWords: saved })}
    />,
  );
};

afterEach(() => {
  cleanup();
});

describe('a recent book says how far through it the reader is', () => {
  it('shows progress as a share of the pages, with a name that says so', () => {
    show([recent()]);

    const bar = screen.getByRole('progressbar');

    expect(bar.getAttribute('value')).toBe('25');
    expect(bar.getAttribute('max')).toBe('100');
    expect(bar.getAttribute('aria-label')).toBe('25% read');
  });

  it('shows none when the length is unknown or the file is gone', () => {
    show([recent({ pageCount: null }), recent({ id: 'doc-2', available: false })]);

    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('never claims more than the whole book', () => {
    show([recent({ lastPage: 40, pageCount: 12 })]);

    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('100');
  });
});

describe('a recent book says how many words were saved from it', () => {
  it('counts them, in the singular and the plural', () => {
    show(
      [recent(), recent({ id: 'doc-2', name: 'tide.pdf' })],
      new Map([
        ['doc-1', 1],
        ['doc-2', 14],
      ]),
    );

    expect(screen.getByText(/· 1 saved word$/)).toBeDefined();
    expect(screen.getByText(/· 14 saved words$/)).toBeDefined();
  });

  it('says nothing for a book with none, or when the counts are not known', () => {
    show([recent()], new Map([['doc-1', 0]]));

    expect(screen.queryByText(/saved word/)).toBeNull();

    cleanup();
    show([recent()]);

    expect(screen.queryByText(/saved word/)).toBeNull();
  });
});

describe('the double-click tip is shown until it has done its work', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('is visible to a reader who has not seen it', () => {
    const { result } = renderHook(() => useLookupHint());

    expect(result.current.visible).toBe(true);
  });

  it('is put away for good once dismissed', () => {
    const { result } = renderHook(() => useLookupHint());

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.visible).toBe(false);
    expect(window.localStorage.getItem(LOOKUP_HINT_STORAGE_KEY)).toBe('1');

    const again = renderHook(() => useLookupHint());

    expect(again.result.current.visible).toBe(false);
  });
});
