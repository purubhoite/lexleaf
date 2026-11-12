import { useCallback, useState } from 'react';

import type { ReadingPoint } from './model/pageLayout';

/**
 * Where the reader was before each jump, so they can go back.
 *
 * Choosing a chapter, a bookmark, a note or a page number takes the
 * reader away from what they were reading. Each such jump remembers the
 * place it left; "Back" returns to the most recent one. Ordinary
 * scrolling is not a jump and is not remembered.
 *
 * The history belongs to one open book: it is cleared when the book
 * changes, and it is not kept between sessions.
 */
const LIMIT = 50;

interface History {
  readonly key: unknown;
  readonly places: readonly ReadingPoint[];
}

export interface JumpHistory {
  readonly canGoBack: boolean;
  /** Remembers the place a jump is about to leave. */
  readonly remember: (place: ReadingPoint) => void;
  /** Forgets the most recent place and returns it. */
  readonly back: () => ReadingPoint | null;
}

export const useJumpHistory = (key: unknown): JumpHistory => {
  const [history, setHistory] = useState<History>({ key, places: [] });

  // Another book: its history starts empty.
  const places = history.key === key ? history.places : [];

  const remember = useCallback(
    (place: ReadingPoint): void => {
      setHistory((current) => {
        const before = current.key === key ? current.places : [];
        const last = before[before.length - 1];

        // Jumping twice from the same place is one step back, not two.
        if (
          last !== undefined &&
          last.page === place.page &&
          Math.abs(last.pageOffsetFraction - place.pageOffsetFraction) < 0.02
        ) {
          return current.key === key ? current : { key, places: before };
        }

        return { key, places: [...before, place].slice(-LIMIT) };
      });
    },
    [key],
  );

  const back = useCallback((): ReadingPoint | null => {
    const last = places[places.length - 1] ?? null;

    if (last !== null) {
      setHistory({ key, places: places.slice(0, -1) });
    }

    return last;
  }, [key, places]);

  return { canGoBack: places.length > 0, remember, back };
};
