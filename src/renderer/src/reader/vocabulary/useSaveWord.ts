import { useCallback, useEffect, useRef, useState } from 'react';

import type { DictionaryResult } from '@core/dictionary/types';
import { extractContext } from '@core/vocabulary/context';
import type { OccurrenceLocation, SavedWordState, VocabularyFailure } from '@core/vocabulary/types';
import { joinSegments } from '@core/word/identifyWord';
import type { DesktopBridge } from '@shared/ipc/contracts';

import type { DictionaryRequest } from '../dictionary/useDictionaryLookup';
import type { PageRegistry } from '../interaction/pageRegistry';

/**
 * Saving the word the popup is showing.
 *
 * All the orchestration lives here so the popup stays a presentational
 * component: it is told what the control says, whether it is busy and
 * whether the last attempt failed, and it reports clicks back.
 *
 * The rules this hook exists to keep:
 *
 * - **Looking a word up never saves it.** A save happens when the reader
 *   presses the button, and at no other moment.
 * - **An answer that arrived for a different word is discarded.** The same
 *   staleness rules as the lookup itself (ADR-018): document, page and
 *   render generation must still match, or the reply is wrong rather than
 *   late.
 * - **A failure keeps the popup open.** The reader is told, in the popup,
 *   and the reading position does not move.
 * - **Nothing from PDF.js or the DOM is persisted.** The excerpt is taken
 *   from the live page text by a pure core function, and what is stored is
 *   characters and numbers.
 */

export type SaveControlState =
  'unknown' | 'not-saved' | 'saved-elsewhere' | 'saved-here' | 'working';

export interface SaveWordControl {
  readonly state: SaveControlState;
  /** How many other places this word was saved from, for the popup to say so. */
  readonly otherPlaces: number;
  /** Set when the last attempt failed; the popup shows it and stays open. */
  readonly error: string | null;
  readonly onSave: () => void;
  readonly onRemove: () => void;
}

export interface SaveWordOptions {
  readonly bridge: DesktopBridge | null;
  readonly registry: PageRegistry;
  readonly documentId: string | null;
  readonly pageCount: number | null;
  readonly request: DictionaryRequest | null;
  readonly result: DictionaryResult | null;
}

interface Attempt {
  readonly state: SaveControlState;
  readonly otherPlaces: number;
  readonly error: string | null;
}

const IDLE: Attempt = { state: 'unknown', otherPlaces: 0, error: null };

/**
 * What to tell the reader when the store refuses.
 *
 * Short, true, and free of anything that would only make sense to someone
 * holding the source code. Reason codes are translated here because this is
 * the only place that knows a human is reading them.
 */
const explain = (failure: VocabularyFailure): string => {
  if (failure.kind === 'write-failed') {
    return 'That word could not be saved.';
  }

  if (failure.kind === 'not-found') {
    return 'That word is no longer saved.';
  }

  if (failure.kind === 'invalid-request') {
    return 'That word could not be saved.';
  }

  switch (failure.reason) {
    case 'not-writable':
      return 'Saved words cannot be stored: the application has nowhere to write them.';
    case 'locked':
      return 'The saved words are in use by another window. Try again in a moment.';
    case 'corrupt':
    case 'not-a-database':
      return 'The saved words file could not be read.';
    case 'schema-too-new':
      return 'The saved words were written by a newer version of this application.';
    case 'migration-failed':
      return 'The saved words file could not be upgraded.';
    default:
      return 'That word could not be saved.';
  }
};

const stateOf = (saved: SavedWordState): Attempt => {
  if (saved.state === 'not-saved') {
    return { state: 'not-saved', otherPlaces: 0, error: null };
  }

  return { state: saved.state, otherPlaces: saved.otherPlaces, error: null };
};

/** Where on the page the word sits, as a fraction of the page's height. */
const offsetFractionOf = (container: HTMLElement, element: Element | null): number | null => {
  if (element === null) {
    return null;
  }

  const page = container.getBoundingClientRect();
  const word = element.getBoundingClientRect();

  if (page.height <= 0) {
    return null;
  }

  const fraction = (word.top - page.top) / page.height;

  return Math.min(Math.max(fraction, 0), 1);
};

/** Which text-layer segment a position in the joined page text falls in. */
const segmentAt = (segmentStarts: readonly number[], position: number): number => {
  let found = 0;

  for (const [index, start] of segmentStarts.entries()) {
    if (start > position) {
      break;
    }

    found = index;
  }

  return found;
};

export const useSaveWord = ({
  bridge,
  registry,
  documentId,
  pageCount,
  request,
  result,
}: SaveWordOptions): SaveWordControl => {
  const [attempt, setAttempt] = useState<Attempt>(IDLE);
  const token = useRef(0);

  const vocabulary = bridge?.vocabulary ?? null;
  const normalized = request?.word.normalized ?? null;
  const page = request?.pageNumber ?? null;
  const generation = request?.generation ?? null;

  /** True when a reply no longer describes what is on screen. */
  const isStale = useCallback((): boolean => {
    if (request === null || documentId === null || request.documentId !== documentId) {
      return true;
    }

    const live = registry.get(request.pageNumber);

    return live === null || live.generation !== request.generation;
  }, [documentId, registry, request]);

  /**
   * One popup, one control state.
   *
   * Reset while rendering rather than in an effect, so the button never
   * shows the previous word's answer for a frame - the same reason the
   * popup itself is derived from the live registry during render.
   */
  const key =
    request === null || documentId === null
      ? null
      : `${documentId}:${String(request.pageNumber)}:${String(request.generation)}:${request.word.normalized}`;
  const [lastKey, setLastKey] = useState<string | null>(key);

  if (key !== lastKey) {
    setLastKey(key);
    setAttempt(IDLE);
  }

  // Asking whether a word is already saved is a read, and it happens when
  // the popup opens. It is not a save, and it must not become one.
  useEffect(() => {
    if (vocabulary === null || normalized === null || documentId === null || page === null) {
      return;
    }

    token.current += 1;
    const issued = token.current;

    void vocabulary
      .stateForWord({ normalized, documentId, page })
      .then((reply) => {
        if (token.current !== issued) {
          return;
        }

        setAttempt(reply.ok ? stateOf(reply.value) : { ...IDLE, state: 'not-saved' });
      })
      .catch(() => {
        if (token.current === issued) {
          setAttempt({ ...IDLE, state: 'not-saved' });
        }
      });
    // `generation` participates so that a re-rendered page asks again.
  }, [vocabulary, normalized, documentId, page, generation]);

  const onSave = useCallback((): void => {
    if (
      vocabulary === null ||
      request === null ||
      result === null ||
      documentId === null ||
      isStale()
    ) {
      return;
    }

    const live = registry.get(request.pageNumber);
    const { word } = request;
    const joined = live === null ? null : joinSegments(live.layer.segments);
    const excerpt = joined === null ? null : extractContext(joined.text, word.start, word.end);

    const occurrence: OccurrenceLocation = {
      page: request.pageNumber,
      charStart: word.start,
      charEnd: word.end,
      pageOffsetFraction:
        live === null || joined === null
          ? null
          : offsetFractionOf(
              live.container,
              live.layer.elements[segmentAt(joined.segmentStarts, word.start)] ?? null,
            ),
      context: excerpt?.context ?? null,
      contextWordStart: excerpt?.contextWordStart ?? null,
    };

    token.current += 1;
    const issued = token.current;

    setAttempt((current) => ({ ...current, state: 'working', error: null }));

    void vocabulary
      .save({
        word: {
          raw: word.raw,
          display: word.display,
          normalized: word.normalized,
          joinedAcrossLines: word.joinedAcrossLines,
        },
        documentId,
        pageCount,
        occurrence,
        result,
      })
      .then((reply) => {
        if (token.current !== issued) {
          return;
        }

        if (!reply.ok) {
          setAttempt({ state: 'not-saved', otherPlaces: 0, error: explain(reply.error) });

          return;
        }

        setAttempt({
          state: 'saved-here',
          otherPlaces: Math.max(reply.value.occurrenceCount - 1, 0),
          error: null,
        });
      })
      .catch(() => {
        if (token.current === issued) {
          setAttempt({
            state: 'not-saved',
            otherPlaces: 0,
            error: 'That word could not be saved.',
          });
        }
      });
  }, [documentId, isStale, pageCount, registry, request, result, vocabulary]);

  /**
   * Removing from the popup removes the word, not the place.
   *
   * The control says "Saved"; a reader pressing it means "I do not want
   * this word", and taking away one occurrence while leaving the entry
   * behind would be a surprise. Occurrence-level editing is not offered
   * anywhere in this milestone.
   */
  const onRemove = useCallback((): void => {
    if (vocabulary === null || normalized === null || documentId === null || page === null) {
      return;
    }

    token.current += 1;
    const issued = token.current;

    setAttempt((current) => ({ ...current, state: 'working', error: null }));

    void vocabulary
      .stateForWord({ normalized, documentId, page })
      .then(async (reply) => {
        if (!reply.ok || reply.value.state === 'not-saved') {
          return { ok: false, error: { kind: 'not-found' } } as const;
        }

        return vocabulary.remove(reply.value.itemId);
      })
      .then((reply) => {
        if (token.current !== issued) {
          return;
        }

        setAttempt(
          reply.ok
            ? { state: 'not-saved', otherPlaces: 0, error: null }
            : { state: 'saved-here', otherPlaces: 0, error: explain(reply.error) },
        );
      })
      .catch(() => {
        if (token.current === issued) {
          setAttempt({
            state: 'saved-here',
            otherPlaces: 0,
            error: 'That word could not be removed.',
          });
        }
      });
  }, [documentId, normalized, page, vocabulary]);

  return {
    state: attempt.state,
    otherPlaces: attempt.otherPlaces,
    error: attempt.error,
    onSave,
    onRemove,
  };
};
