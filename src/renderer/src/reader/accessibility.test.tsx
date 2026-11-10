/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ZOOM, type ZoomState } from '@core/persistence/types';

import { ReaderToolbar } from './ReaderToolbar';
import { SearchPanel } from './SearchPanel';
import type { SearchState } from './useDocumentSearch';

/**
 * Accessibility baseline for the reader chrome (Milestone 6.2).
 *
 * Two of the five elements the 6.1 audit found unadopted live here: the
 * search panel's "Match case" checkbox and, through the toolbar, the zoom
 * control whose accessible name used to change with its value. The tests
 * are about behaviour and semantics, not about the class names 6.2
 * introduced: a checkbox that stops being a checkbox, or a name that starts
 * moving again, fails here.
 */

const searchState = (overrides: Partial<SearchState> = {}): SearchState => ({
  status: 'idle',
  query: { text: '', caseSensitive: false },
  matches: [],
  currentIndex: null,
  scannedPages: 0,
  totalPages: 10,
  truncated: false,
  ...overrides,
});

const showSearch = (
  overrides: Partial<SearchState> = {},
  onSearch: (text: string, caseSensitive: boolean) => void = (): void => {},
): void => {
  render(
    <SearchPanel
      state={searchState(overrides)}
      onSearch={onSearch}
      onNext={(): void => {}}
      onPrevious={(): void => {}}
      onClose={(): void => {}}
    />,
  );
};

const showToolbar = (zoom: ZoomState = DEFAULT_ZOOM, scale = 1): void => {
  render(
    <ReaderToolbar
      documentName="essay.pdf"
      currentPage={1}
      pageCount={10}
      zoom={zoom}
      scale={scale}
      searchOpen={false}
      onOpen={(): void => {}}
      onClose={(): void => {}}
      onGoToPage={(): void => {}}
      onZoomIn={(): void => {}}
      onZoomOut={(): void => {}}
      onZoomChange={(): void => {}}
      onToggleSearch={(): void => {}}
    />,
  );
};

afterEach(() => {
  cleanup();
});

describe('the "Match case" checkbox (6.1 audit, finding 4)', () => {
  it('is still a native checkbox with a real label', () => {
    showSearch();

    const checkbox = screen.getByLabelText('Match case');

    expect(checkbox.tagName).toBe('INPUT');
    expect(checkbox.getAttribute('type')).toBe('checkbox');
    // Never replaced by a button pretending to be one.
    expect(checkbox.getAttribute('role')).toBeNull();
    expect(checkbox.getAttribute('aria-checked')).toBeNull();
  });

  it('carries the checked state natively rather than through a class', () => {
    showSearch({ query: { text: 'a', caseSensitive: true } });

    const checkbox = screen.getByLabelText('Match case');

    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('is wrapped by a label that is itself the target', () => {
    showSearch();

    const label = screen.getByLabelText('Match case').closest('label');

    // The label is what gives the 24px target; the checkbox keeps its own
    // native size. Losing the class silently shrinks the target to the
    // platform checkbox, which is what the audit objected to.
    expect(label).not.toBeNull();
    expect(label?.className.split(/\s+/u)).toContain('checkbox');
  });

  it('still runs the search when toggled, so the focus work changed nothing', () => {
    const onSearch = vi.fn();

    showSearch({ query: { text: 'lighthouse', caseSensitive: false } }, onSearch);
    fireEvent.click(screen.getByLabelText('Match case'));

    expect(onSearch).toHaveBeenCalledWith('lighthouse', true);
  });
});

describe('the zoom control keeps one name (W12, AC 9)', () => {
  it('is named for what it is, not for what it currently shows', () => {
    showToolbar();

    expect(screen.getByLabelText('Zoom level').tagName).toBe('SELECT');
  });

  it('keeps that name when the value changes', () => {
    const names = (): string | null => {
      const select = screen.getByLabelText('Zoom level');

      return select.getAttribute('aria-label');
    };

    showToolbar({ mode: 'fixed', scale: 1 }, 1);
    expect(names()).toBeNull();
    cleanup();

    showToolbar({ mode: 'fit-width', scale: 1 }, 1.37);
    expect(names()).toBeNull();
    expect(screen.getByLabelText('Zoom level')).toBeDefined();
    cleanup();

    showToolbar({ mode: 'fixed', scale: 4 }, 4);
    expect(screen.getByLabelText('Zoom level')).toBeDefined();
  });

  it('still states the current zoom visibly, which is where the value belongs', () => {
    showToolbar({ mode: 'fit-width', scale: 1 }, 1.37);

    expect(screen.getByText('Fit width (137 %)')).toBeDefined();
  });
});
