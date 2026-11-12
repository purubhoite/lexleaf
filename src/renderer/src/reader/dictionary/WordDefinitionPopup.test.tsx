/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DictionaryAttribution,
  DictionaryResult,
  DictionarySense,
} from '@core/dictionary/types';

import { WordDefinitionPopup, type SaveControl } from './WordDefinitionPopup';

/**
 * What the reader sees, and — just as important — what they do not: no
 * empty pronunciation row, no invented example, no explanation of a word
 * the dictionary could not answer.
 */

const attribution: DictionaryAttribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Modified: filtered and reformatted for this application.',
  credits: ['Princeton University', 'The Open English WordNet team'],
};

const sense = (definition: string, overrides: Partial<DictionarySense> = {}): DictionarySense => ({
  partOfSpeech: 'noun',
  definition,
  examples: [],
  synonyms: [],
  source: 'wordnet',
  ...overrides,
});

const found = (
  overrides: Partial<Extract<DictionaryResult, { status: 'found' }>> = {},
): DictionaryResult => ({
  status: 'found',
  queried: 'lighthouse',
  headword: 'lighthouse',
  resolvedBy: 'exact',
  senses: [sense('A tower with a light that warns ships.')],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution,
  ...overrides,
});

const anchor = { left: 300, top: 200, width: 80, height: 18 };
const viewport = { width: 1280, height: 900 };

const saveControl = (overrides: Partial<SaveControl> = {}): SaveControl => ({
  state: 'not-saved',
  otherPlaces: 0,
  error: null,
  onSave: (): void => {},
  onRemove: (): void => {},
  ...overrides,
});

const show = (
  result: DictionaryResult | null,
  options: {
    loading?: boolean;
    displayWord?: string;
    onClose?: () => void;
    save?: SaveControl;
  } = {},
): void => {
  render(
    <WordDefinitionPopup
      anchor={anchor}
      displayWord={options.displayWord ?? 'lighthouse'}
      loading={options.loading ?? false}
      result={result}
      onClose={options.onClose ?? ((): void => {})}
      {...(options.save === undefined ? {} : { save: options.save })}
      viewport={viewport}
    />,
  );
};

afterEach(() => {
  cleanup();
});

describe('WordDefinitionPopup', () => {
  it('is a dialog named for the word the reader asked about', () => {
    show(found());

    expect(screen.getByRole('dialog', { name: 'Definition of lighthouse' })).toBeDefined();
  });

  it('takes focus when it opens and gives it back when it closes', () => {
    const trigger = document.createElement('button');

    document.body.append(trigger);
    trigger.focus();

    show(found());

    expect(document.activeElement).toBe(screen.getByTestId('dictionary-popup'));

    cleanup();

    expect(document.activeElement).toBe(trigger);
  });

  it('shows the definition, the part of speech and a genuine example', () => {
    show(
      found({
        senses: [
          sense('A tower with a light that warns ships.', {
            examples: ['the lighthouse swept the bay'],
            synonyms: ['beacon'],
          }),
        ],
      }),
    );

    expect(screen.getByText(/A tower with a light that warns ships\./u)).toBeDefined();
    expect(screen.getByText('noun')).toBeDefined();
    expect(screen.getByText(/the lighthouse swept the bay/u)).toBeDefined();
    expect(screen.getByText(/beacon/u)).toBeDefined();
  });

  it('shows no example or synonym row when the entry has none', () => {
    const { container } = render(
      <WordDefinitionPopup
        anchor={anchor}
        displayWord="lighthouse"
        loading={false}
        result={found()}
        onClose={(): void => {}}
        viewport={viewport}
      />,
    );

    expect(container.querySelector('.dictionary-popup__example')).toBeNull();
    expect(container.querySelector('.dictionary-popup__synonyms')).toBeNull();
    expect(container.querySelector('.dictionary-popup__pronunciation')).toBeNull();
  });

  it('shows the pronunciation with its variety when the release has one', () => {
    show(
      found({
        pronunciations: [
          { value: 'ˈlaɪthaʊs', variety: 'GB' },
          { value: 'ˈlaɪthaʊs', variety: 'US' },
        ],
      }),
    );

    expect(screen.getByText(/GB/u)).toBeDefined();
    expect(screen.getByText(/US/u)).toBeDefined();
  });

  it('says which headword answered when it is not the word on the page', () => {
    show(found({ queried: 'mice', headword: 'mouse' }), { displayWord: 'mice' });

    expect(screen.getByTestId('dictionary-fallback').textContent).toContain('mouse');
  });

  it('does not claim a fallback when the headword only differs in case', () => {
    show(found({ queried: 'London', headword: 'london' }), { displayWord: 'London' });

    expect(screen.queryByTestId('dictionary-fallback')).toBeNull();
  });

  it('shows three senses and offers the rest', () => {
    const senses = [1, 2, 3, 4, 5].map((number) => sense(`Definition number ${String(number)}.`));

    show(found({ senses }));

    expect(screen.queryByText('Definition number 4.', { exact: false })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More senses (2)' }));

    expect(screen.getByText(/Definition number 5\./u)).toBeDefined();
  });

  it('discloses an inflection without demoting the exact entry', () => {
    show(found({ queried: 'running', headword: 'running', alsoInflectionOf: ['run'] }), {
      displayWord: 'running',
    });

    const senses = screen.getAllByRole('listitem');

    expect(senses[0]?.textContent).toContain('A tower with a light');
    expect(screen.getByTestId('dictionary-shadowing').textContent).toContain('run');
  });

  it('marks a grammar note as written for this application', () => {
    show(
      found({
        senses: [
          sense('Used before a noun.', { partOfSpeech: 'determiner', source: 'application' }),
        ],
      }),
      { displayWord: 'the' },
    );

    expect(screen.getByText(/written for this application/u)).toBeDefined();
  });

  it('offers the attribution without putting it in the reader’s way', () => {
    show(found());

    const details = screen.getByText('Dictionary source').closest('details');

    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.textContent).toContain('Princeton University');
    expect(details?.textContent).toContain('CC BY 4.0');
    expect(details?.textContent).toContain('Modified:');
  });

  it('says only that nothing was found, and still offers to save the word', () => {
    show(
      { status: 'not-found', queried: 'zzz', attempted: ['zzz'] },
      {
        displayWord: 'zzz',
        save: saveControl(),
      },
    );

    expect(screen.getByText('No dictionary entry found.')).toBeDefined();
    expect(screen.getByTestId('vocabulary-save').textContent).toBe('Save word');
    expect(screen.queryByRole('button', { name: 'Explain in context' })).toBeNull();
  });

  describe('the save control', () => {
    it('is absent until the popup is told what it should say', () => {
      show(found(), { save: saveControl({ state: 'unknown' }) });

      expect(screen.queryByTestId('vocabulary-save')).toBeNull();
    });

    it('offers to save a word that is not saved', () => {
      show(found(), { save: saveControl() });

      expect(screen.getByTestId('vocabulary-save').textContent).toBe('Save word');
    });

    it('offers to add this place for a word saved elsewhere', () => {
      show(found(), { save: saveControl({ state: 'saved-elsewhere', otherPlaces: 2 }) });

      expect(screen.getByTestId('vocabulary-save').textContent).toBe('Save from here');
    });

    it('says the word is saved as a statement, not as a button (0.2.3)', () => {
      show(found(), { save: saveControl({ state: 'saved-here', otherPlaces: 3 }) });

      // Pressing "Saved" used to remove the word. It is no longer something
      // that can be pressed.
      expect(screen.queryByTestId('vocabulary-save')).toBeNull();
      expect(screen.getByTestId('vocabulary-saved').tagName).toBe('P');
      expect(screen.getByTestId('vocabulary-saved').textContent).toBe('Saved to your words');
      expect(screen.getByTestId('vocabulary-other-places').textContent).toContain('3 other places');
    });

    it('reports a save, and a removal only from the control that says Remove', () => {
      const onSave = vi.fn();
      const onRemove = vi.fn();

      show(found(), { save: saveControl({ onSave, onRemove }) });
      fireEvent.click(screen.getByTestId('vocabulary-save'));

      expect(onSave).toHaveBeenCalledTimes(1);

      cleanup();
      show(found(), { save: saveControl({ state: 'saved-here', onSave, onRemove }) });
      fireEvent.click(screen.getByTestId('vocabulary-saved'));

      expect(onRemove).not.toHaveBeenCalled();

      const remove = screen.getByTestId('vocabulary-remove');

      expect(remove.textContent).toBe('Remove from saved words');
      fireEvent.click(remove);

      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('cannot be pressed twice while it is working', () => {
      show(found(), { save: saveControl({ state: 'working' }) });

      expect(screen.getByTestId('vocabulary-save').hasAttribute('disabled')).toBe(true);
    });

    it('shows a failure inside the popup, which stays open', () => {
      show(found(), { save: saveControl({ error: 'That word could not be saved.' }) });

      expect(screen.getByTestId('vocabulary-error').textContent).toBe(
        'That word could not be saved.',
      );
      expect(screen.getByTestId('dictionary-popup')).toBeDefined();
    });
  });

  it('says only that the dictionary could not be loaded', () => {
    show({ status: 'unavailable', reason: 'corrupt' });

    const popup = screen.getByTestId('dictionary-popup');

    expect(screen.getByTestId('dictionary-unavailable').textContent).toBe(
      'The dictionary could not be loaded.',
    );
    expect(popup.textContent).not.toMatch(/corrupt|path|dictionary\.idx/u);
  });

  it('shows a loading message and nothing else while it waits', () => {
    show(null, { loading: true });

    expect(screen.getByRole('status').textContent).toContain('Looking up');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('closes on Escape without letting the reader lose anything else', () => {
    const onClose = vi.fn();
    const outer = vi.fn();

    document.addEventListener('keydown', outer);
    show(found(), { onClose });

    fireEvent.keyDown(screen.getByTestId('dictionary-popup'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();

    document.removeEventListener('keydown', outer);
  });

  it('closes when the reader clicks outside it', () => {
    const onClose = vi.fn();

    show(found(), { onClose });

    fireEvent.pointerDown(screen.getByTestId('dictionary-popup'));

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes from its own close button', () => {
    const onClose = vi.fn();

    show(found(), { onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Close definition' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps Tab inside itself while it is open', () => {
    show(found({ senses: [1, 2, 3, 4].map((n) => sense(`Definition ${String(n)}.`)) }));

    const popup = screen.getByTestId('dictionary-popup');

    fireEvent.keyDown(popup, { key: 'Tab', shiftKey: true });

    expect(popup.contains(document.activeElement)).toBe(true);
  });

  it('is positioned over the page, not in its flow', () => {
    show(found());

    const popup = screen.getByTestId('dictionary-popup');

    expect(popup.style.position).toBe('fixed');
    expect(popup.style.top).toBe(`${String(200 + 18 + 8)}px`);
    expect(popup.getAttribute('data-placement')).toBe('below');
  });

  it('flips above a word near the bottom of the viewport', () => {
    render(
      <WordDefinitionPopup
        anchor={{ left: 300, top: 870, width: 80, height: 18 }}
        displayWord="lighthouse"
        loading={false}
        result={found({ senses: [1, 2, 3, 4, 5].map((n) => sense(`Definition ${String(n)}.`)) })}
        onClose={(): void => {}}
        viewport={viewport}
      />,
    );

    expect(screen.getByTestId('dictionary-popup').getAttribute('data-placement')).toBe('above');
  });

  it('stays inside the viewport for a word at the right-hand edge', () => {
    render(
      <WordDefinitionPopup
        anchor={{ left: 1260, top: 200, width: 80, height: 18 }}
        displayWord="lighthouse"
        loading={false}
        result={found()}
        onClose={(): void => {}}
        viewport={viewport}
      />,
    );

    const popup = screen.getByTestId('dictionary-popup');

    expect(
      Number.parseInt(popup.style.left, 10) + Number.parseInt(popup.style.width, 10),
    ).toBeLessThanOrEqual(viewport.width);
  });

  it('does not scroll the document when it opens', () => {
    const before = { x: window.scrollX, y: window.scrollY };
    const scrollTo = vi.spyOn(window, 'scrollTo');

    show(found());

    expect(scrollTo).not.toHaveBeenCalled();
    expect({ x: window.scrollX, y: window.scrollY }).toEqual(before);
  });
});
