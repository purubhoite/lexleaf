import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DictionaryResult } from '@core/dictionary/types';
import type { IdentifiedWord } from '@core/word/types';
import type { DesktopBridge } from '@shared/ipc/contracts';

import type { PageRegistry } from '../interaction/pageRegistry';
import type { WordInteraction } from '../interaction/resolveInteraction';

/**
 * One definition lookup, tied to the word that asked for it.
 *
 * Lookups are asynchronous and the reader is not waiting for them: by the
 * time an answer arrives the page may have been recycled, the document may
 * have been closed, or the reader may have double-clicked something else.
 * Every one of those makes the answer wrong rather than merely late, so the
 * hook attaches the full identity of the interaction to each request —
 * document, page, render generation (ADR-018) — and discards anything that
 * no longer matches.
 *
 * The loading state is deliberately delayed: a lookup that answers in a
 * millisecond must not make the interface flicker.
 */

export interface DictionaryRequest {
  readonly documentId: string;
  readonly pageNumber: number;
  readonly generation: number;
  readonly word: IdentifiedWord;
}

export interface DictionaryLookupState {
  /** `pending` is "asked, too early to say so"; `loading` is visible. */
  readonly status: 'closed' | 'pending' | 'loading' | 'ready';
  readonly request: DictionaryRequest | null;
  readonly result: DictionaryResult | null;
}

export interface DictionaryLookupControls {
  readonly state: DictionaryLookupState;
  /** Starts a lookup for an interaction that resolved to a word. */
  open: (interaction: WordInteraction) => void;
  close: () => void;
}

export interface DictionaryLookupOptions {
  readonly bridge: DesktopBridge | null;
  readonly registry: PageRegistry;
  readonly documentId: string | null;
  /** Milliseconds before a slow lookup admits to being slow. */
  readonly loadingDelayMs?: number;
}

export const LOADING_DELAY_MS = 120;

const CLOSED: DictionaryLookupState = { status: 'closed', request: null, result: null };

const UNAVAILABLE: DictionaryResult = { status: 'unavailable', reason: 'unreadable' };

export const useDictionaryLookup = ({
  bridge,
  registry,
  documentId,
  loadingDelayMs = LOADING_DELAY_MS,
}: DictionaryLookupOptions): DictionaryLookupControls => {
  const [state, setState] = useState<DictionaryLookupState>(CLOSED);
  const token = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const readVersion = useCallback(() => registry.version(), [registry]);
  const liveVersion = useSyncExternalStore(subscribe, readVersion);

  const cancelTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const close = useCallback((): void => {
    token.current += 1;
    cancelTimer();
    setState(CLOSED);
  }, []);

  /** True when a request no longer describes something on screen. */
  const isStale = useCallback(
    (request: DictionaryRequest): boolean => {
      if (documentId === null || request.documentId !== documentId) {
        return true;
      }

      const page = registry.get(request.pageNumber);

      return page === null || page.generation !== request.generation;
    },
    [documentId, registry],
  );

  const open = useCallback(
    (interaction: WordInteraction): void => {
      if (interaction.hit.kind !== 'word') {
        return;
      }

      const request: DictionaryRequest = {
        documentId: interaction.documentId,
        pageNumber: interaction.pageNumber,
        generation: interaction.generation,
        word: interaction.hit.word,
      };

      token.current += 1;
      cancelTimer();

      const issued = token.current;

      setState({ status: 'pending', request, result: null });

      timer.current = setTimeout(() => {
        timer.current = null;

        setState((current) =>
          token.current === issued && current.status === 'pending'
            ? { ...current, status: 'loading' }
            : current,
        );
      }, loadingDelayMs);

      const settle = (result: DictionaryResult): void => {
        // Superseded by a newer interaction, or the page it belonged to is
        // gone: the answer is not late, it is wrong.
        if (token.current !== issued) {
          return;
        }

        cancelTimer();

        if (isStale(request)) {
          setState(CLOSED);

          return;
        }

        setState({ status: 'ready', request, result });
      };

      if (bridge === null) {
        settle(UNAVAILABLE);

        return;
      }

      bridge
        .lookUpWord({
          normalized: request.word.normalized,
          raw: request.word.raw,
          joinedAcrossLines: request.word.joinedAcrossLines,
        })
        .then(settle, () => {
          settle(UNAVAILABLE);
        });
    },
    [bridge, isStale, loadingDelayMs],
  );

  useEffect(() => cancelTimer, []);

  // An open popup whose page has been re-rendered or recycled is dismissed.
  // Derived during render rather than corrected afterwards in an effect: the
  // popup must vanish in the same frame as the word it points at, and a
  // state update chasing the registry would show it for one frame too long.
  // `liveVersion` is what makes React re-render when the live set changes.
  void liveVersion;

  const visible = state.request !== null && isStale(state.request) ? CLOSED : state;

  return { state: visible, open, close };
};
