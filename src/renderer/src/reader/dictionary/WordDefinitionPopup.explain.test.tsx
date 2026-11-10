/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { DictionaryAttribution, DictionaryResult } from '@core/dictionary/types';

import type { ExplainControl as ExplainControlState } from '../ai/useExplainInContext';

import { WordDefinitionPopup } from './WordDefinitionPopup';

/**
 * Where the explanation control may appear, and where it may not.
 *
 * The dictionary is primary: an explanation is offered next to an answer,
 * including the honest answer "no entry found" — but never in place of a
 * dictionary that could not be loaded, and never above the definition.
 */

const attribution: DictionaryAttribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Modified.',
  credits: ['Princeton University'],
};

const found: DictionaryResult = {
  status: 'found',
  queried: 'charge',
  headword: 'charge',
  resolvedBy: 'exact',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'A quantity of electricity.',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution,
};

const partial: DictionaryResult = {
  ...found,
  status: 'partial',
  resolvedBy: 'morphology',
  absentFields: ['pronunciation'],
};

const notFound: DictionaryResult = { status: 'not-found', queried: 'quux', attempted: ['quux'] };

const unavailable: DictionaryResult = { status: 'unavailable', reason: 'not-installed' };

const explain = (overrides: Partial<ExplainControlState> = {}): ExplainControlState => ({
  state: 'idle',
  explanation: null,
  message: null,
  destination: { configured: true, provider: 'api.example.com', model: 'model-a', remote: true },
  onExplain: (): void => {},
  onCancel: (): void => {},
  ...overrides,
});

const show = (result: DictionaryResult, control = explain()): void => {
  render(
    <WordDefinitionPopup
      anchor={{ left: 300, top: 200, width: 80, height: 18 }}
      displayWord="charge"
      loading={false}
      result={result}
      onClose={(): void => {}}
      explain={control}
      viewport={{ width: 1280, height: 900 }}
    />,
  );
};

afterEach(() => {
  cleanup();
});

describe('where the explanation control appears', () => {
  it.each([
    ['an entry that was found', found],
    ['an entry shown for another headword', partial],
    ['a word with no entry at all', notFound],
  ])('offers it for %s', (_name, result) => {
    show(result);

    expect(screen.getByTestId('explain-in-context')).toBeTruthy();
    expect(screen.getByTestId('explanation-disclosure')).toBeTruthy();
  });

  it('never offers it when the dictionary could not be loaded', () => {
    show(unavailable);

    expect(screen.queryByTestId('explain-control')).toBeNull();
    expect(screen.getByTestId('dictionary-unavailable')).toBeTruthy();
  });

  it('is absent entirely when no provider is configured', () => {
    show(found, explain({ state: 'unsupported', destination: null }));

    expect(screen.queryByTestId('explain-control')).toBeNull();
    expect(screen.getByText('A quantity of electricity.')).toBeTruthy();
  });

  it('is absent when the popup was given no explanation control at all', () => {
    render(
      <WordDefinitionPopup
        anchor={{ left: 300, top: 200, width: 80, height: 18 }}
        displayWord="charge"
        loading={false}
        result={found}
        onClose={(): void => {}}
        viewport={{ width: 1280, height: 900 }}
      />,
    );

    expect(screen.queryByTestId('explain-control')).toBeNull();
  });
});

describe('the definition keeps its place', () => {
  it('shows the dictionary senses above the explanation', () => {
    show(
      found,
      explain({
        state: 'ready',
        explanation: {
          text: 'Here it means stored electricity.',
          senseIndex: 0,
          truncated: false,
          createdAt: '2026-02-01T10:00:00.000Z',
          provider: 'api.example.com',
          model: 'model-a',
          remote: true,
          status: 'current',
        },
      }),
    );

    const definition = screen.getByText('A quantity of electricity.');
    const explanation = screen.getByTestId('explanation-text');

    expect(
      definition.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('survives a failed explanation without losing the definition', () => {
    show(
      found,
      explain({ state: 'failed', message: 'Context explanation is currently unavailable.' }),
    );

    expect(screen.getByText('A quantity of electricity.')).toBeTruthy();
    expect(screen.getByTestId('explanation-error')).toBeTruthy();
  });
});
