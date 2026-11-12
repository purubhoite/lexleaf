/** @vitest-environment jsdom */
import type { Highlight } from '@core/annotations/annotations';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnnotationPopup,
  placeAnnotationPopup,
  type AnnotationPopupProps,
} from './AnnotationPopup';

afterEach(() => {
  cleanup();
});

const highlight: Highlight = {
  id: 'h1',
  page: 1,
  start: 0,
  end: 4,
  text: 'word',
  colour: 'blue',
  note: 'a thought',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const show = (overrides: Partial<AnnotationPopupProps> = {}) => {
  const props: AnnotationPopupProps = {
    anchor: { left: 100, top: 100, width: 50, height: 16 },
    highlight: null,
    noteOpen: false,
    onColour: vi.fn(),
    onOpenNote: vi.fn(),
    onNoteChange: vi.fn(),
    onRemove: vi.fn(),
    onListen: vi.fn(),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };

  render(<AnnotationPopup {...props} />);

  return props;
};

describe('where the bar goes', () => {
  const viewport = { width: 1000, height: 700 };

  it('sits below the words, centred on them', () => {
    expect(
      placeAnnotationPopup({ left: 400, top: 100, width: 100, height: 20 }, viewport, 52),
    ).toStrictEqual({ left: 306, top: 128 });
  });

  it('goes above when there is no room below', () => {
    const place = placeAnnotationPopup(
      { left: 400, top: 660, width: 100, height: 20 },
      viewport,
      52,
    );

    expect(place.top).toBe(600);
  });

  it('stays inside the window at either edge', () => {
    expect(
      placeAnnotationPopup({ left: 0, top: 100, width: 10, height: 20 }, viewport, 52).left,
    ).toBe(8);
    expect(
      placeAnnotationPopup({ left: 990, top: 100, width: 10, height: 20 }, viewport, 52).left,
    ).toBe(704);
  });
});

describe('the bar by a selection', () => {
  it('offers four colours, a note, listening and copying, but nothing to remove', () => {
    const props = show();

    fireEvent.click(screen.getByTestId('highlight-green'));
    fireEvent.click(screen.getByTestId('highlight-note'));
    fireEvent.click(screen.getByTestId('highlight-listen'));
    fireEvent.click(screen.getByTestId('highlight-copy'));

    expect(props.onColour).toHaveBeenCalledWith('green');
    expect(props.onOpenNote).toHaveBeenCalledOnce();
    expect(props.onListen).toHaveBeenCalledOnce();
    expect(props.onCopy).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('highlight-remove')).toBeNull();
    expect(screen.queryByTestId('highlight-note-field')).toBeNull();
  });

  it('closes on Escape without letting the key go further', () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);

    const props = show();

    fireEvent.keyDown(screen.getByTestId('annotation-popup'), { key: 'Escape' });
    window.removeEventListener('keydown', outer);

    expect(props.onClose).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('the bar by a highlight', () => {
  it('marks the colour in use and can remove the highlight', () => {
    const props = show({ highlight });

    expect(screen.getByTestId('highlight-blue').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('highlight-pink').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('highlight-remove'));

    expect(props.onRemove).toHaveBeenCalledOnce();
  });

  it('opens the note with the cursor in it and passes on what is typed', () => {
    const props = show({ highlight, noteOpen: true });
    const field = screen.getByTestId<HTMLTextAreaElement>('highlight-note-field');

    expect(field.value).toBe('a thought');
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: 'a better thought' } });

    expect(props.onNoteChange).toHaveBeenCalledWith('a better thought');
  });
});
