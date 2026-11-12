/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ZOOM } from '@core/persistence/types';

import { ReaderToolbar } from './ReaderToolbar';

/**
 * Toolbar grouping and sizing (Milestone 6.4, CTL-1, CTL-2, CTL-4, CTL-5).
 *
 * The toolbar's fourteen controls were already correct one at a time; what
 * 6.4 changed is the structure around them. These tests hold the structure
 * to the things that break silently: a group that loses its name, an
 * icon-only button whose pointer name and screen-reader name drift apart,
 * and the page field's draft/commit behaviour, which is Milestone 2's and
 * must survive being resized.
 */

const show = (overrides: Partial<Parameters<typeof ReaderToolbar>[0]> = {}): void => {
  render(
    <ReaderToolbar
      documentName="essay.pdf"
      currentPage={1}
      pageCount={10}
      zoom={DEFAULT_ZOOM}
      scale={1}
      searchOpen={false}
      hasOutline={false}
      outlineOpen={false}
      onToggleOutline={(): void => {}}
      onOpen={(): void => {}}
      onClose={(): void => {}}
      onGoToPage={(): void => {}}
      onZoomIn={(): void => {}}
      onZoomOut={(): void => {}}
      onZoomChange={(): void => {}}
      onToggleSearch={(): void => {}}
      {...overrides}
    />,
  );
};

/** A button whose whole label is a drawn icon: it has no readable text of its own. */
const isIconOnly = (button: HTMLElement): boolean =>
  (button.textContent ?? '').trim().length === 0 && button.querySelector('svg') !== null;

afterEach(() => {
  cleanup();
});

describe('the toolbar keeps four named groups (CTL-1)', () => {
  it('groups every control under file, page, zoom and search', () => {
    show();

    const names = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label') ?? '');

    // "File" rather than "Document" since 6.5: the scrolling region that
    // holds the pages is the Document, and two things with one name are
    // two things a screen-reader user cannot tell apart (6.4 audit, C6).
    expect(names).toStrictEqual(['File', 'Page navigation', 'Zoom', 'Search']);
  });

  it('leaves no control outside a group', () => {
    show();

    const grouped = screen
      .getAllByRole('group')
      .flatMap((group) => [...group.querySelectorAll('button, input, select')]);
    const all = [...document.querySelectorAll('button, input, select')];

    expect(grouped).toHaveLength(all.length);
  });
});

describe('icon-only controls name themselves twice over (CTL-2)', () => {
  it('finds icon-only controls to judge, so the rule cannot pass vacuously', () => {
    show();

    expect(screen.getAllByRole('button').filter(isIconOnly).length).toBeGreaterThanOrEqual(4);
  });

  it('gives the pointer the same name it gives the screen reader', () => {
    show();

    const drifting = screen
      .getAllByRole('button')
      .filter(isIconOnly)
      .filter((button) => button.getAttribute('title') !== button.getAttribute('aria-label'));

    expect(drifting.map((button) => button.textContent)).toStrictEqual([]);
  });

  it('never leaves a glyph as the only name a control has', () => {
    show();

    const unnamed = screen
      .getAllByRole('button')
      .filter(isIconOnly)
      .filter((button) => (button.getAttribute('aria-label') ?? '').trim() === '');

    expect(unnamed).toStrictEqual([]);
  });
});

describe('the document name cannot push the controls away (CTL-5)', () => {
  it('keeps the full name reachable through its title', () => {
    const name = `${'extremely-long-conference-proceedings-'.repeat(4)}.pdf`;

    show({ documentName: name });

    expect(screen.getByTitle(name).textContent).toBe(name);
  });

  it('is allowed to shrink: it is the flexible item, not the buttons', () => {
    show();

    // The truncation itself is a layout fact and is checked in the
    // stylesheet test; what the component must do is mark the name as the
    // element that gives way, which it does by class.
    expect(screen.getByTitle('essay.pdf').className).toContain('reader__name');
  });
});

describe('the page field keeps its Milestone 2 behaviour (CTL-4)', () => {
  it('does not navigate while the page number is being typed', () => {
    const onGoToPage = vi.fn();

    show({ onGoToPage, pageCount: 99999 });

    fireEvent.change(screen.getByLabelText('Page number'), { target: { value: '1234' } });

    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it('accepts a five-digit page number and commits it', () => {
    const onGoToPage = vi.fn();

    show({ onGoToPage, pageCount: 99999 });

    const field = screen.getByLabelText('Page number');

    fireEvent.change(field, { target: { value: '12345' } });
    fireEvent.blur(field);

    expect(onGoToPage).toHaveBeenCalledWith(12345);
  });

  it('still clamps a page number beyond the end of the document', () => {
    const onGoToPage = vi.fn();

    show({ onGoToPage, pageCount: 10 });

    const field = screen.getByLabelText('Page number');

    fireEvent.change(field, { target: { value: '99999' } });
    fireEvent.blur(field);

    expect(onGoToPage).toHaveBeenCalledWith(10);
  });
});

describe('the contents button', () => {
  it('is off, with the reason, for a document that has no table of contents', () => {
    show();

    const button = screen.getByTestId<HTMLButtonElement>('outline-toggle');

    expect(button.disabled).toBe(true);
    expect(button.title).toBe('This document has no table of contents');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens and closes the contents and says which it is', () => {
    const onToggleOutline = vi.fn();
    show({ hasOutline: true, outlineOpen: true, onToggleOutline });

    const button = screen.getByTestId<HTMLButtonElement>('outline-toggle');

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(button);

    expect(onToggleOutline).toHaveBeenCalledOnce();
  });
});
