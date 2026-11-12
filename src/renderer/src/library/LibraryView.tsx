import type { ReactElement } from 'react';

import type { LibrarySort, SavedWord, VocabularyFailure } from '@core/vocabulary/types';

import { LibraryExport, type ExportLibrary } from './LibraryExport';
import type { LibraryControls } from './useVocabularyLibrary';
import { Icon } from '../ui/Icon';
import { Message } from '../ui/Message';

/**
 * The library screen.
 *
 * It lists what the reader saved and offers exactly two actions on each
 * entry: go back to where the word was met, and remove it. Everything a
 * card shows is something they put there — the word, the definition they
 * kept, the document, the page, the date — so there is nothing to explain
 * and nothing invented.
 *
 * Loading, empty and failed are three different screens. A library that
 * cannot be read says so and offers to try again; it never shows an empty
 * list, which would say the reader had saved nothing.
 */

export interface LibraryViewProps {
  readonly library: LibraryControls;
  /** Opens the place a word was met. Absent while no bridge exists. */
  readonly onOpenOrigin: (item: SavedWord) => void;
  readonly onClose: () => void;
  /** Writes every saved word to a file. Absent while no bridge exists. */
  readonly onExport?: ExportLibrary;
}

const SORT_LABELS: readonly { readonly value: LibrarySort; readonly label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'alphabetical', label: 'A to Z' },
];

const describeFailure = (failure: VocabularyFailure): string => {
  if (failure.kind !== 'unavailable') {
    return 'The saved words could not be read.';
  }

  switch (failure.reason) {
    case 'not-writable':
      return 'The saved words cannot be stored: the application has nowhere to write them.';
    case 'locked':
      return 'The saved words are in use by another window.';
    case 'schema-too-new':
      return 'The saved words were written by a newer version of this application.';
    case 'corrupt':
    case 'not-a-database':
      return 'The saved words file could not be read. Nothing has been deleted.';
    case 'migration-failed':
      return 'The saved words file could not be upgraded. Nothing has been changed.';
    default:
      return 'The saved words could not be read.';
  }
};

const savedOn = (iso: string): string => {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

const firstPlace = (item: SavedWord): SavedWord['occurrences'][number] | null =>
  item.occurrences[0] ?? null;

const Card = ({
  item,
  onOpenOrigin,
  onRemove,
}: {
  readonly item: SavedWord;
  readonly onOpenOrigin: (item: SavedWord) => void;
  readonly onRemove: (item: SavedWord) => void;
}): ReactElement => {
  const place = firstPlace(item);
  const partOfSpeech = item.snapshot?.senses[0]?.partOfSpeech ?? null;

  return (
    <li className="library__card" data-testid="library-card">
      <div className="library__card-head">
        <h3 className="library__word">{item.word.display}</h3>
        {partOfSpeech !== null && <span className="library__part">{partOfSpeech}</span>}
      </div>

      {item.shortDefinition !== null && (
        <p className="library__definition">{item.shortDefinition}</p>
      )}

      {item.lookupStatus === 'not-found' && (
        <p className="library__definition library__definition--absent">
          No dictionary entry was found when this word was saved.
        </p>
      )}

      <p className="library__provenance">
        {place === null ? (
          'Saved'
        ) : (
          <>
            {place.documentName}, page {String(place.page)}
          </>
        )}{' '}
        · {savedOn(item.savedAt)}
        {item.occurrenceCount > 1 && (
          <span className="library__count" data-testid="library-occurrences">
            {' '}
            · met {String(item.occurrenceCount)} times
          </span>
        )}
      </p>

      <div className="library__actions">
        <button
          type="button"
          className="control library__action"
          onClick={(): void => {
            onOpenOrigin(item);
          }}
        >
          Show in book
        </button>
        <button
          type="button"
          className="control library__action"
          onClick={(): void => {
            onRemove(item);
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
};

export const LibraryView = ({
  library,
  onOpenOrigin,
  onClose,
  onExport,
}: LibraryViewProps): ReactElement => {
  const { state } = library;

  return (
    <section className="library" aria-label="Saved words" data-testid="library">
      <header className="library__header">
        <h2 className="library__title">Saved words</h2>
        <button
          type="button"
          className="control control--quiet library__close"
          aria-label="Close saved words"
          title="Close saved words"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="library__controls">
        <label className="library__control">
          <span>Search</span>
          <input
            className="control control--field"
            type="search"
            value={state.query}
            placeholder="Word or definition"
            data-testid="library-search"
            onChange={(event): void => {
              library.setQuery(event.target.value);
            }}
          />
        </label>

        <label className="library__control">
          <span>Document</span>
          <select
            className="control"
            value={state.documentId ?? ''}
            data-testid="library-document"
            onChange={(event): void => {
              library.setDocument(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">All documents</option>
            {state.documents.map((option) => (
              <option key={option.documentId} value={option.documentId}>
                {option.name} ({String(option.count)}){option.available ? '' : ' — file not found'}
              </option>
            ))}
          </select>
        </label>

        <label className="library__control">
          <span>Order</span>
          <select
            className="control"
            value={state.sort}
            data-testid="library-sort"
            onChange={(event): void => {
              library.setSort(event.target.value as LibrarySort);
            }}
          >
            {SORT_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {onExport !== undefined && <LibraryExport onExport={onExport} />}

      {state.status === 'loading' && (
        <Message kind="busy" testId="library-loading">
          Loading saved words…
        </Message>
      )}

      {state.status === 'failed' && state.failure !== null && (
        <div className="library__problem" data-testid="library-failed">
          <Message kind="problem">{describeFailure(state.failure)}</Message>
          <button type="button" className="control" onClick={library.reload}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && state.items.length === 0 && (
        <Message kind="empty" testId="library-empty">
          {state.query.trim().length === 0
            ? 'No words saved yet. Look a word up while reading and press Save word.'
            : 'No saved words match that search. Clear the search to see every saved word.'}
        </Message>
      )}

      {state.unreadable > 0 && (
        <Message kind="problem" testId="library-unreadable">
          {String(state.unreadable)} {state.unreadable === 1 ? 'entry' : 'entries'} could not be
          read. Nothing has been deleted.
        </Message>
      )}

      {state.truncated && (
        <Message kind="info" testId="library-truncated">
          Showing the first 200 matches. Narrow the search to see fewer.
        </Message>
      )}

      {state.items.length > 0 && (
        <ul className="library__list">
          {state.items.map((item) => (
            <Card key={item.id} item={item} onOpenOrigin={onOpenOrigin} onRemove={library.remove} />
          ))}
        </ul>
      )}

      {state.hasMore && (
        <button
          type="button"
          className="control library__more"
          data-testid="library-more"
          disabled={state.loadingMore}
          onClick={library.loadMore}
        >
          {state.loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}

      {state.undo !== null && (
        <div className="library__undo" role="status" data-testid="library-undo">
          <span>Removed {state.undo.item.word.display}.</span>
          <button type="button" className="control" onClick={library.undoRemove}>
            Undo
          </button>
          <button type="button" className="control" onClick={library.dismissUndo}>
            Dismiss
          </button>
          {/*
            The undo bar is itself a live region (M4), so it already
            announces this sentence when it appears inside it. A nested
            alert would say it a second time.
          */}
          {state.undo.failed && (
            <Message kind="problem" announce={false} testId="library-undo-failed">
              That word could not be put back.
            </Message>
          )}
        </div>
      )}
    </section>
  );
};
