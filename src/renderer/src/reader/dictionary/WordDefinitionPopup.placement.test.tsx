/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DictionaryAttribution,
  DictionaryResult,
  DictionarySense,
} from '@core/dictionary/types';

import type { ExplanationIpcView } from '@shared/ipc/aiContracts';

import type { ExplainControl as ExplainControlState } from '../ai/useExplainInContext';

import { POPUP_GAP, POPUP_MIN_HEIGHT, placePopup, popupWidth } from './placePopup';
import { WordDefinitionPopup } from './WordDefinitionPopup';

/**
 * How the popup behaves as a positioned thing (Milestone 6.3).
 *
 * `placePopup.test.ts` proves the arithmetic. This file proves the wiring:
 * that the component measures what it renders, re-measures when the
 * content changes under it — including when an explanation arrives some
 * seconds later — and puts the arrow where the placement said.
 *
 * jsdom has no layout, so geometry is supplied rather than pretended:
 * `scrollHeight` on the scrolling box is the one number the component
 * measures, and the `ResizeObserver` it registers is a real one for the
 * purposes of this test — the test holds its callback and fires it, which
 * is exactly what the browser does when the box changes size.
 */

const attribution: DictionaryAttribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Modified.',
  credits: ['Princeton University'],
};

const sense = (definition: string): DictionarySense => ({
  partOfSpeech: 'noun',
  definition,
  examples: [],
  synonyms: [],
  source: 'wordnet',
});

const found = (senses = 1): DictionaryResult => ({
  status: 'found',
  queried: 'lighthouse',
  headword: 'lighthouse',
  resolvedBy: 'exact',
  senses: Array.from({ length: senses }, (_, index) => sense(`Sense number ${String(index + 1)}.`)),
  pronunciations: [],
  alsoInflectionOf: [],
  attribution,
});

const explain = (overrides: Partial<ExplainControlState> = {}): ExplainControlState => ({
  state: 'idle',
  explanation: null,
  message: null,
  destination: { configured: true, provider: 'api.example.com', model: 'model-a', remote: true },
  onExplain: (): void => {},
  onCancel: (): void => {},
  ...overrides,
});

/** A finished explanation, shaped exactly as the IPC layer delivers one. */
const explanation: ExplanationIpcView = {
  text: 'A tower that warns ships; here it is used literally.',
  senseIndex: 0,
  truncated: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  provider: 'api.example.com',
  model: 'model-a',
  remote: true,
  status: 'current',
};

const viewport = { width: 1280, height: 900 };
const anchor = { left: 300, top: 200, width: 80, height: 18 };

/** The height the content currently claims to be. */
let contentHeight = 0;
/** Every ResizeObserver callback the component has registered. */
let observers: ResizeObserverCallback[] = [];
let observed: Element[] = [];

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(callback);
  }

  observe(target: Element): void {
    observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    observers = observers.filter((entry) => entry !== this.callback);
  }
}

/**
 * What the browser does after a box changes size: deliver the observation
 * and let React render the consequence. `act` is how a test says "and then
 * the frame happened"; without it the state update is queued and the
 * assertion reads the DOM from before the resize.
 */
const resizeContentTo = (height: number): void => {
  contentHeight = height;
  act(() => {
    for (const callback of [...observers]) {
      callback([], {} as ResizeObserver);
    }
  });
};

beforeEach(() => {
  contentHeight = 0;
  observers = [];
  observed = [];
  vi.stubGlobal('ResizeObserver', TestResizeObserver);

  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains('dictionary-popup__scroll') ? contentHeight : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<Record<'scrollHeight', unknown>>).scrollHeight;
});

const show = (
  options: {
    result?: DictionaryResult;
    anchor?: typeof anchor;
    explain?: ExplainControlState;
    viewport?: typeof viewport;
  } = {},
): ReturnType<typeof render> =>
  render(
    <WordDefinitionPopup
      anchor={options.anchor ?? anchor}
      displayWord="lighthouse"
      loading={false}
      result={options.result ?? found()}
      onClose={(): void => {}}
      viewport={options.viewport ?? viewport}
      {...(options.explain === undefined ? {} : { explain: options.explain })}
    />,
  );

const popup = (): HTMLElement => screen.getByTestId('dictionary-popup');
const topOf = (): number => Number.parseFloat(popup().style.top);
const leftOf = (): number => Number.parseFloat(popup().style.left);

describe('the popup measures what it renders', () => {
  it('observes its own scrolling box, not the window', () => {
    show();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.className).toBe('dictionary-popup__scroll');
  });

  it('places itself from the measured height, not from the estimate', () => {
    // 700px of content next to a word 200px down a 900px viewport: there
    // are 674px below, so it still belongs below — but it must be the
    // measured height that says so.
    contentHeight = 700;
    show();

    expect(popup().dataset['placement']).toBe('below');
    expect(topOf()).toBe(placePopup(anchor, 700, viewport).top);
  });

  it('shows the first frame in its final position, with nothing to correct', () => {
    // The word is far enough down that a tall popup has to go above it.
    // If the component painted its estimate first the reader would see
    // the popup below the word and then watch it jump (W11), so the very
    // first DOM the test can observe must already be the measured one.
    const low = { ...anchor, top: 700 };

    contentHeight = 400;
    show({ anchor: low });

    const measured = placePopup(low, 400, viewport);

    expect(popup().dataset['placement']).toBe('above');
    expect(topOf()).toBe(measured.top);
    expect(measured.placement).toBe('above');
  });

  it('falls back to the minimum-height estimate when nothing can be measured', () => {
    // jsdom's real behaviour: every box is zero. The popup must not treat
    // "unmeasurable" as "zero high" and place itself against nothing.
    show();

    expect(topOf()).toBe(placePopup(anchor, POPUP_MIN_HEIGHT, viewport).top);
  });

  it('guesses a short popup rather than a viewport-tall one before measuring', () => {
    /*
     * This is W11, and it is the one thing about the first paint that a
     * test without layout can still pin down. The word sits 500px down a
     * 900px viewport: 374px of room below it. A popup guessed to be
     * viewport-tall fits in neither direction and opens *above* the word,
     * then drops below the moment it is measured — the jump the reader
     * used to see. Guessed at its minimum, it opens below and stays.
     *
     * Nothing is measurable here (every jsdom box is zero), so what the
     * component renders is the guess itself, which is exactly what needs
     * checking.
     */
    const middling = { ...anchor, top: 500 };

    show({ anchor: middling });

    expect(popup().dataset['placement']).toBe('below');
    expect(topOf()).toBe(placePopup(middling, POPUP_MIN_HEIGHT, viewport).top);
    // The guess the old code made, kept here so the two cannot converge
    // silently: if this ever stops differing, the test above is vacuous.
    expect(placePopup(middling, viewport.height, viewport).placement).toBe('above');
  });
});

describe('placement is recomputed when the content changes (W10, AC 14)', () => {
  it('re-places when the box grows without any prop changing', () => {
    const low = { ...anchor, top: 700 };

    contentHeight = 120;
    show({ anchor: low });
    const before = topOf();

    expect(popup().dataset['placement']).toBe('below');

    resizeContentTo(420);

    expect(popup().dataset['placement']).toBe('above');
    expect(topOf()).not.toBe(before);
    expect(topOf()).toBe(placePopup(low, 420, viewport).top);
  });

  it('re-places when an explanation arrives', () => {
    const low = { ...anchor, top: 700 };

    contentHeight = 120;
    const view = show({ anchor: low, explain: explain() });
    const before = topOf();

    // The explanation lands: the popup is taller than it was.
    contentHeight = 500;
    view.rerender(
      <WordDefinitionPopup
        anchor={low}
        displayWord="lighthouse"
        loading={false}
        result={found()}
        onClose={(): void => {}}
        explain={explain({ state: 'ready', explanation })}
        viewport={viewport}
      />,
    );

    expect(topOf()).not.toBe(before);
    expect(topOf()).toBe(placePopup(low, 500, viewport).top);
  });

  it('re-places when an explanation fails instead of arriving', () => {
    const low = { ...anchor, top: 700 };

    contentHeight = 120;
    const view = show({ anchor: low, explain: explain() });
    const before = topOf();

    contentHeight = 420;
    view.rerender(
      <WordDefinitionPopup
        anchor={low}
        displayWord="lighthouse"
        loading={false}
        result={found()}
        onClose={(): void => {}}
        explain={explain({ state: 'failed', message: 'The explanation could not be produced.' })}
        viewport={viewport}
      />,
    );

    expect(topOf()).toBe(placePopup(low, 420, viewport).top);
    expect(topOf()).not.toBe(before);
  });

  it('re-places when "More senses" expands the list', () => {
    const low = { ...anchor, top: 700 };

    contentHeight = 120;
    show({ anchor: low, result: found(8) });

    expect(popup().dataset['placement']).toBe('below');

    // Pressing the control is what grows the box, so the growth is
    // reported the way the browser would report it.
    contentHeight = 500;
    fireEvent.click(screen.getByRole('button', { name: /More senses/u }));

    expect(popup().dataset['placement']).toBe('above');
    expect(topOf()).toBe(placePopup(low, 500, viewport).top);
  });

  it('re-places when the result itself is replaced', () => {
    const low = { ...anchor, top: 700 };

    contentHeight = 120;
    const view = show({ anchor: low });
    const before = topOf();

    contentHeight = 640;
    view.rerender(
      <WordDefinitionPopup
        anchor={low}
        displayWord="lighthouse"
        loading={false}
        result={found(6)}
        onClose={(): void => {}}
        viewport={viewport}
      />,
    );

    expect(topOf()).not.toBe(before);
    expect(topOf()).toBe(placePopup(low, 640, viewport).top);
  });

  it('stops observing when it closes', () => {
    const view = show();

    expect(observers).toHaveLength(1);

    view.unmount();

    expect(observers).toHaveLength(0);
  });
});

describe('placement follows the viewport', () => {
  it('re-places when the window is resized', () => {
    // No injected viewport here: the component reads the window, which is
    // the path that has to respond to a resize.
    contentHeight = 300;
    render(
      <WordDefinitionPopup
        anchor={{ left: 900, top: 200, width: 80, height: 18 }}
        displayWord="lighthouse"
        loading={false}
        result={found()}
        onClose={(): void => {}}
      />,
    );

    const before = leftOf();

    window.innerWidth = 700;
    window.innerHeight = 500;
    fireEvent(window, new Event('resize'));

    expect(leftOf()).not.toBe(before);
    expect(leftOf() + popupWidth({ width: 700, height: 500 })).toBeLessThanOrEqual(700);
  });

  it('is as wide as the placement says, and no wider', () => {
    show();

    expect(popup().style.width).toBe(`${String(popupWidth(viewport))}px`);
  });
});

describe('the arrow', () => {
  it('is rendered at the offset the placement computed', () => {
    show();

    const arrow = screen.getByTestId('dictionary-popup-arrow');

    expect(arrow.style.left).toBe(
      `${String(placePopup(anchor, POPUP_MIN_HEIGHT, viewport).arrowLeft ?? 0)}px`,
    );
  });

  it('is hidden from assistive technology, which already has the word', () => {
    show();

    expect(screen.getByTestId('dictionary-popup-arrow')).toHaveProperty('ariaHidden', 'true');
  });

  it('is outside the scrolling box, so it cannot be clipped away', () => {
    show();

    const arrow = screen.getByTestId('dictionary-popup-arrow');

    expect(arrow.parentElement).toBe(popup());
    expect(arrow.closest('.dictionary-popup__scroll')).toBeNull();
  });

  it('adds nothing to the content the popup measures', () => {
    show();

    const scroll = popup().querySelector('.dictionary-popup__scroll');

    expect(scroll?.contains(screen.getByTestId('dictionary-popup-arrow'))).toBe(false);
  });

  it('is absent when the word is off the side of the popup', () => {
    show({ anchor: { left: 1279, top: 200, width: 80, height: 18 } });

    expect(screen.queryByTestId('dictionary-popup-arrow')).toBeNull();
  });
});

describe('the popup never covers the word it defines (D2, AC 12)', () => {
  it.each([
    ['below the word', 200],
    ['above the word', 760],
    ['against the top edge', 2],
    ['against the bottom edge', 880],
  ])('%s', (_name, top) => {
    const where = { ...anchor, top };

    contentHeight = 500;
    show({ anchor: where });

    const rendered = {
      top: topOf(),
      height: Math.min(500, Number.parseFloat(popup().style.maxHeight)),
    };

    const clear =
      rendered.top >= where.top + where.height || rendered.top + rendered.height <= where.top;

    expect(clear).toBe(true);
    expect(rendered.top).toBeGreaterThanOrEqual(0);
  });

  it('keeps the gap between the word and the popup', () => {
    contentHeight = 200;
    show();

    expect(topOf()).toBe(anchor.top + anchor.height + POPUP_GAP);
  });
});

describe('positioning never moves the document', () => {
  it('does not scroll anything into view', () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();

    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollTo = scrollTo;

    contentHeight = 700;
    show({ anchor: { ...anchor, top: 860 } });
    resizeContentTo(900);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
