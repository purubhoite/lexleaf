import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import type { SearchState } from './useDocumentSearch';

/**
 * Finding text in the document.
 *
 * The panel reports three distinct things a reader needs to tell apart: a
 * search still running, a search that found nothing, and which match of how
 * many they are looking at. The count is announced politely so that the
 * information is not only visual.
 */

export interface SearchPanelProps {
  readonly state: SearchState;
  readonly onSearch: (text: string, caseSensitive: boolean) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

const summarise = (state: SearchState): string => {
  if (state.query.text.trim() === '') {
    return '';
  }

  if (state.matches.length === 0) {
    return state.status === 'running'
      ? `Searching… ${String(state.scannedPages)} of ${String(state.totalPages)} pages`
      : 'No matches';
  }

  const position = state.currentIndex === null ? 1 : state.currentIndex + 1;
  const total = `${String(state.matches.length)}${state.truncated ? '+' : ''}`;
  const match = state.currentIndex === null ? null : state.matches[state.currentIndex];
  const page = match === undefined || match === null ? '' : ` · page ${String(match.pageNumber)}`;

  return `${String(position)} of ${total}${page}${state.status === 'running' ? ' (still searching)' : ''}`;
};

export const SearchPanel = ({
  state,
  onSearch,
  onNext,
  onPrevious,
  onClose,
}: SearchPanelProps): ReactElement => {
  const [text, setText] = useState(state.query.text);
  const [caseSensitive, setCaseSensitive] = useState(state.query.caseSensitive);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    // Submitting the same query again means "next match", which is what
    // every other reader does with the return key.
    if (text === state.query.text && caseSensitive === state.query.caseSensitive) {
      onNext();
    } else {
      onSearch(text, caseSensitive);
    }
  };

  return (
    <form className="search" onSubmit={submit} role="search">
      <label>
        <span className="visually-hidden">Find in document</span>
        <input
          ref={inputRef}
          type="search"
          className="control control--field search__input"
          placeholder="Find in document"
          value={text}
          onChange={(event): void => {
            setText(event.target.value);
          }}
          onKeyDown={(event): void => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </label>

      <button type="submit" className="control">
        Find
      </button>
      <button
        type="button"
        className="control"
        aria-label="Previous match"
        onClick={onPrevious}
        disabled={state.matches.length === 0}
      >
        ◀
      </button>
      <button
        type="button"
        className="control"
        aria-label="Next match"
        onClick={onNext}
        disabled={state.matches.length === 0}
      >
        ▶
      </button>

      <label className="checkbox search__option">
        <input
          type="checkbox"
          className="checkbox__input"
          checked={caseSensitive}
          onChange={(event): void => {
            setCaseSensitive(event.target.checked);
            onSearch(text, event.target.checked);
          }}
        />
        <span>Match case</span>
      </label>

      <output className="search__status" aria-live="polite">
        {summarise(state)}
      </output>

      <button type="button" className="control" onClick={onClose}>
        Close
      </button>
    </form>
  );
};
