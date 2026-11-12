/** @vitest-environment jsdom */
import type { SavedWord } from '@core/vocabulary/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExportLibrary } from './LibraryExport';
import { LibraryView } from './LibraryView';
import { aSavedWord, anOccurrence } from './libraryFixtures';
import type { LibraryControls, LibraryState } from './useVocabularyLibrary';

/**
 * The library screen.
 *
 * The tests here are about what the reader is told: four distinguishable
 * states, cards that show only what they themselves put there, and exactly
 * two actions on an entry.
 */

const baseState: LibraryState = {
  status: 'ready',
  items: [],
  documents: [],
  sort: 'newest',
  documentId: null,
  query: '',
  hasMore: false,
  loadingMore: false,
  truncated: false,
  unreadable: 0,
  failure: null,
  undo: null,
  nonce: 0,
};

const controls = (state: Partial<LibraryState> = {}): LibraryControls => ({
  state: { ...baseState, ...state },
  setSort: vi.fn(),
  setDocument: vi.fn(),
  setQuery: vi.fn(),
  loadMore: vi.fn(),
  reload: vi.fn(),
  remove: vi.fn(),
  undoRemove: vi.fn(),
  dismissUndo: vi.fn(),
});

const show = (
  library: LibraryControls,
  onOpenOrigin: (item: SavedWord) => void = vi.fn(),
): void => {
  render(<LibraryView library={library} onOpenOrigin={onOpenOrigin} onClose={vi.fn()} />);
};

afterEach(() => {
  cleanup();
});

describe('the library screen', () => {
  it('says it is loading rather than showing an empty list', () => {
    show(controls({ status: 'loading' }));

    expect(screen.getByTestId('library-loading')).toBeTruthy();
    expect(screen.queryByTestId('library-empty')).toBeNull();
  });

  it('invites the reader to save a word when nothing is saved yet', () => {
    show(controls());

    expect(screen.getByTestId('library-empty').textContent).toContain('No words saved yet');
  });

  it('says a search found nothing without claiming the library is empty', () => {
    show(controls({ query: 'zzz' }));

    expect(screen.getByTestId('library-empty').textContent).toContain('No saved words match');
  });

  it('explains a failure and offers to try again, instead of showing no words', () => {
    const library = controls({
      status: 'failed',
      failure: { kind: 'unavailable', reason: 'corrupt' },
    });

    show(library);

    expect(screen.getByTestId('library-failed').textContent).toContain('Nothing has been deleted');
    expect(screen.queryByTestId('library-empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(library.reload).toHaveBeenCalled();
  });

  it('never shows a filesystem path in a failure', () => {
    show(controls({ status: 'failed', failure: { kind: 'unavailable', reason: 'not-writable' } }));

    const text = screen.getByTestId('library-failed').textContent ?? '';

    expect(text).not.toMatch(/[/\\]|\.db/);
  });

  it('shows the word, its definition, part of speech, document, page and date', () => {
    show(controls({ items: [aSavedWord()] }));

    const card = screen.getByTestId('library-card');

    expect(card.textContent).toContain('equanimity');
    expect(card.textContent).toContain('steadiness of mind under stress');
    expect(card.textContent).toContain('noun');
    expect(card.textContent).toContain('Meditations.pdf');
    expect(card.textContent).toContain('page 12');
  });

  it('counts the places a word was met only when there is more than one', () => {
    show(
      controls({
        items: [
          aSavedWord({ id: 'once' }),
          aSavedWord({
            id: 'thrice',
            occurrenceCount: 3,
            occurrences: [anOccurrence(), anOccurrence({ page: 40 })],
          }),
        ],
      }),
    );

    const counts = screen.getAllByTestId('library-occurrences');

    expect(counts).toHaveLength(1);
    expect(counts[0]?.textContent).toContain('met 3 times');
  });

  it('says plainly when no entry was found, rather than leaving a blank card', () => {
    show(
      controls({
        items: [aSavedWord({ lookupStatus: 'not-found', shortDefinition: null, snapshot: null })],
      }),
    );

    expect(screen.getByTestId('library-card').textContent).toContain(
      'No dictionary entry was found',
    );
  });

  it('offers exactly two actions on an entry', () => {
    show(controls({ items: [aSavedWord()] }));

    const actions = screen
      .getByTestId('library-card')
      .querySelectorAll<HTMLButtonElement>('button');

    expect([...actions].map((button) => button.textContent)).toEqual(['Open origin', 'Remove']);
  });

  it('asks to open the place a word was met', () => {
    const onOpenOrigin = vi.fn();

    show(controls({ items: [aSavedWord()] }), onOpenOrigin);
    fireEvent.click(screen.getByRole('button', { name: 'Open origin' }));

    expect(onOpenOrigin).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }));
  });

  it('removes an entry and offers to undo it', () => {
    const library = controls({
      items: [aSavedWord()],
      undo: { item: aSavedWord(), failed: false },
    });

    show(library);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(library.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(library.undoRemove).toHaveBeenCalled();
  });

  it('says when a search answer was cut short at two hundred', () => {
    show(controls({ items: [aSavedWord()], truncated: true, query: 'e' }));

    expect(screen.getByTestId('library-truncated').textContent).toContain('first 200 matches');
  });

  it('counts rows it could not read without deleting them', () => {
    show(controls({ items: [aSavedWord()], unreadable: 3 }));

    expect(screen.getByTestId('library-unreadable').textContent).toContain('3 entries');
  });

  it('marks a document whose file is missing, and still lets it be chosen', () => {
    show(
      controls({
        documents: [{ documentId: 'doc-b', name: 'Gone.pdf', available: false, count: 2 }],
      }),
    );

    const option = screen.getByTestId('library-document').querySelector('option[value="doc-b"]');

    expect(option?.textContent).toContain('file not found');
  });

  it('asks for more only when there is more', () => {
    const library = controls({ items: [aSavedWord()], hasMore: true });

    show(library);
    fireEvent.click(screen.getByTestId('library-more'));

    expect(library.loadMore).toHaveBeenCalled();
  });

  it('offers the three orderings', () => {
    show(controls());

    const options = screen
      .getByTestId('library-sort')
      .querySelectorAll<HTMLOptionElement>('option');

    expect([...options].map((option) => option.value)).toEqual([
      'newest',
      'oldest',
      'alphabetical',
    ]);
  });
});

describe('exporting from the library', () => {
  const showWithExport = (onExport: ExportLibrary): void => {
    render(
      <LibraryView
        library={controls({ items: [aSavedWord()] })}
        onOpenOrigin={vi.fn()}
        onClose={vi.fn()}
        onExport={onExport}
      />,
    );
  };

  it('offers no export where there is nothing to export with', () => {
    show(controls({ items: [aSavedWord()] }));

    expect(screen.queryByTestId('library-export-csv')).toBeNull();
    expect(screen.queryByTestId('library-export-anki')).toBeNull();
  });

  it('asks for the format the reader pressed and says how many words were written', async () => {
    const onExport = vi.fn<ExportLibrary>(() => Promise.resolve({ status: 'exported', count: 12 }));
    showWithExport(onExport);

    fireEvent.click(screen.getByTestId('library-export-anki'));

    expect(onExport).toHaveBeenCalledExactlyOnceWith('anki');
    expect((await screen.findByTestId('library-export-status')).textContent).toBe(
      'Exported 12 saved words.',
    );

    fireEvent.click(screen.getByTestId('library-export-csv'));

    expect(onExport).toHaveBeenLastCalledWith('csv');
  });

  it('does not start a second export while one is under way', () => {
    const onExport = vi.fn<ExportLibrary>(() => new Promise(() => undefined));
    showWithExport(onExport);

    fireEvent.click(screen.getByTestId('library-export-csv'));
    fireEvent.click(screen.getByTestId('library-export-anki'));

    expect(onExport).toHaveBeenCalledOnce();
    expect(screen.getByTestId<HTMLButtonElement>('library-export-anki').disabled).toBe(true);
  });

  it('says nothing when the reader cancels, and re-enables the buttons', async () => {
    const onExport = vi.fn<ExportLibrary>(() => Promise.resolve({ status: 'cancelled' }));
    showWithExport(onExport);

    fireEvent.click(screen.getByTestId('library-export-csv'));

    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('library-export-csv').disabled).toBe(false);
    });
    expect(screen.queryByTestId('library-export-status')).toBeNull();
  });

  it('says so when the export fails, including when the bridge throws', async () => {
    const onExport = vi.fn<ExportLibrary>(() => Promise.reject(new Error('gone')));
    showWithExport(onExport);

    fireEvent.click(screen.getByTestId('library-export-csv'));

    expect((await screen.findByTestId('library-export-status')).textContent).toContain(
      'could not be exported',
    );
  });
});
