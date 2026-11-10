/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  DictionaryAttribution,
  DictionaryResult,
  DictionarySense,
} from '@core/dictionary/types';

import { WordDefinitionPopup, announceResult } from './WordDefinitionPopup';

/**
 * The result announcement (A11Y-8, W13, D6).
 *
 * Milestone 2 deferred this and nothing has announced a definition since.
 * What matters is not that a live region exists but that it behaves: it
 * must speak once when the result lands, must not move focus, must not say
 * the same thing twice when the popup re-renders, and must not become a
 * second voice competing with the one that was already there.
 */

const attribution: DictionaryAttribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Modified: filtered and reformatted for this application.',
  credits: ['Princeton University', 'The Open English WordNet team'],
};

const sense = (definition: string): DictionarySense => ({
  partOfSpeech: 'noun',
  definition,
  examples: [],
  synonyms: [],
  source: 'wordnet',
});

const found = (senses: string[]): DictionaryResult => ({
  status: 'found',
  queried: 'lighthouse',
  headword: 'lighthouse',
  resolvedBy: 'exact',
  senses: senses.map(sense),
  pronunciations: [],
  alsoInflectionOf: [],
  attribution,
});

const anchor = { left: 300, top: 200, width: 80, height: 18 };
const viewport = { width: 1280, height: 900 };

const popup = (result: DictionaryResult | null, loading: boolean): React.ReactElement => (
  <WordDefinitionPopup
    anchor={anchor}
    displayWord="lighthouse"
    loading={loading}
    result={result}
    onClose={(): void => {}}
    viewport={viewport}
  />
);

afterEach(() => {
  cleanup();
});

describe('announceResult', () => {
  it('summarises a definition without reading it out', () => {
    expect(announceResult(found(['A tower with a light.']), 'lighthouse')).toBe(
      'lighthouse: definition available, 1 sense.',
    );
    expect(announceResult(found(['One.', 'Two.', 'Three.']), 'lighthouse')).toBe(
      'lighthouse: definition available, 3 senses.',
    );
  });

  it('names the word the reader asked about when there is no entry', () => {
    expect(announceResult({ status: 'not-found', queried: 'zzz', attempted: ['zzz'] }, 'zzz')).toBe(
      'No dictionary entry found for zzz.',
    );
  });

  it('says only that the dictionary could not be loaded', () => {
    const said = announceResult({ status: 'unavailable', reason: 'corrupt' }, 'lighthouse');

    expect(said).toBe('The dictionary could not be loaded.');
    expect(said).not.toMatch(/corrupt|path|\.idx|provider/iu);
  });

  it('says nothing at all before a result exists', () => {
    expect(announceResult(null, 'lighthouse')).toBe('');
  });

  it('announces the headword that answered, not the inflected form typed', () => {
    const result = { ...found(['To run.']), queried: 'running', headword: 'run' };

    expect(announceResult(result, 'running')).toContain('run: definition available');
  });
});

describe('the popup live region', () => {
  it('is the same element before and after the result arrives', () => {
    const view = render(popup(null, true));
    const during = screen.getByTestId('dictionary-status');

    expect(during.textContent).toContain('Looking up');

    view.rerender(popup(found(['A tower with a light.']), false));

    const after = screen.getByTestId('dictionary-status');

    // Not a new node: a screen reader announces a change inside a region
    // it is already watching far more reliably than the insertion of a
    // fresh one.
    expect(after).toBe(during);
    expect(after.getAttribute('role')).toBe('status');
    expect(after.textContent).toBe('lighthouse: definition available, 1 sense.');
  });

  it('stops being visible once the definition itself is on screen', () => {
    const view = render(popup(null, true));

    expect(screen.getByTestId('dictionary-status').className).toContain('dictionary-popup__status');

    view.rerender(popup(found(['A tower with a light.']), false));

    expect(screen.getByTestId('dictionary-status').className).toBe('visually-hidden');
  });

  it('does not repeat itself when the popup re-renders', () => {
    const result = found(['One.', 'Two.', 'Three.', 'Four.']);
    const view = render(popup(result, false));
    const announcement = screen.getByTestId('dictionary-status').textContent;

    fireEvent.click(screen.getByRole('button', { name: 'More senses (1)' }));
    view.rerender(popup(result, false));

    const node = screen.getByTestId('dictionary-status');

    expect(node.textContent).toBe(announcement);
    expect(document.querySelectorAll('[data-testid="dictionary-status"]')).toHaveLength(1);
  });

  it('is the only live region in the popup, so nothing is said twice', () => {
    render(popup(found(['A tower with a light.']), false));

    const popupElement = screen.getByTestId('dictionary-popup');

    expect(popupElement.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(popupElement.querySelectorAll('[aria-live]')).toHaveLength(0);
    // A11Y-7: nothing is both a status and an alert.
    expect(popupElement.querySelectorAll('[role="status"][role~="alert"]')).toHaveLength(0);
  });

  it('stays the only live region in every state the popup can be in (6.5)', () => {
    // 6.5 gave the popup's visible problem and empty lines the shared
    // message component, which is a live region by default. Each of those
    // lines sits beside the status node that has already announced the
    // same event, so each one has to opt out. Testing only the found
    // state would miss exactly that: the states with a second line are
    // the unavailable one and the two empty ones.
    const states: (DictionaryResult | null)[] = [
      null,
      found(['A tower with a light.']),
      { status: 'not-found', queried: 'lighthouse', attempted: ['lighthouse'] },
      { status: 'unavailable', reason: 'not-installed' },
      { status: 'unavailable', reason: 'unreadable' },
    ];

    for (const result of states) {
      cleanup();
      render(popup(result, result === null));

      const popupElement = screen.getByTestId('dictionary-popup');
      const live = popupElement.querySelectorAll('[role="status"], [role="alert"], [aria-live]');

      expect({
        state: result === null ? 'loading' : `${result.status}`,
        live: live.length,
      }).toStrictEqual({
        state: result === null ? 'loading' : `${result.status}`,
        live: 1,
      });
    }
  });

  it('does not move focus when the result lands', () => {
    const elsewhere = document.createElement('button');

    document.body.append(elsewhere);

    const view = render(popup(null, true));

    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    view.rerender(popup(found(['A tower with a light.']), false));

    expect(document.activeElement).toBe(elsewhere);

    elsewhere.remove();
  });

  it('announces a miss as well as a hit', () => {
    const view = render(popup(null, true));

    view.rerender(
      popup({ status: 'not-found', queried: 'lighthouse', attempted: ['lighthouse'] }, false),
    );

    expect(screen.getByTestId('dictionary-status').textContent).toBe(
      'No dictionary entry found for lighthouse.',
    );
  });
});
