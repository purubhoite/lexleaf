import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DictionaryResult } from '@core/dictionary/types';
import { extractContext } from '@core/vocabulary/context';
import { joinSegments } from '@core/word/identifyWord';
import type { AiStatusReply, ExplanationIpcView } from '@shared/ipc/aiContracts';
import type { DesktopBridge } from '@shared/ipc/contracts';

import { LOADING_DELAY_MS, type DictionaryRequest } from '../dictionary/useDictionaryLookup';
import type { PageRegistry } from '../interaction/pageRegistry';

/**
 * Explaining the word the popup is showing, in the passage it appears in.
 *
 * The orchestration lives here so the control stays presentational, and the
 * rules it exists to keep are the ones that make this feature acceptable at
 * all:
 *
 * - **Nothing leaves until the reader asks.** Opening the popup reads what
 *   is already stored and nothing else. The only thing that sends an
 *   excerpt anywhere is a press of the button, which is why the disclosure
 *   sits on the control itself.
 * - **The passage is captured when the button is pressed**, from the live
 *   text layer, by the same pure core function the save path uses — not
 *   from whatever the popup happened to be holding when it opened.
 * - **A reply that no longer describes what is on screen is wrong, not
 *   late.** Document, page, render generation (ADR-018) and word identity
 *   all take part, and so does a request token, so an answer for a
 *   superseded press is discarded rather than shown.
 * - **The dictionary comes first and does not depend on this.** Every
 *   failure here leaves the definition exactly where it was, and with no
 *   provider configured the control does not exist.
 */

export type ExplainState =
  'unsupported' | 'idle' | 'pending' | 'loading' | 'ready' | 'stale' | 'failed';

export interface ExplainControl {
  readonly state: ExplainState;
  /** Present for `ready` and `stale`. */
  readonly explanation: ExplanationIpcView | null;
  /** Present for `failed`. One sentence, with no provider detail in it. */
  readonly message: string | null;
  /** Where an excerpt would go, for the disclosure. `null` when unsupported. */
  readonly destination: AiStatusReply | null;
  readonly onExplain: () => void;
  readonly onCancel: () => void;
}

export interface ExplainInContextOptions {
  readonly bridge: DesktopBridge | null;
  readonly registry: PageRegistry;
  readonly documentId: string | null;
  readonly request: DictionaryRequest | null;
  readonly result: DictionaryResult | null;
  /** Milliseconds before a slow request admits to being slow. */
  readonly loadingDelayMs?: number;
}

/**
 * The only thing a reader is told when a request does not produce an
 * explanation.
 *
 * Deliberately one sentence for every cause. A status code, a provider
 * message or a URL would be the provider talking to the reader through a
 * surface nobody reviewed, and the remedy is the same in every case: press
 * Retry, or carry on reading.
 */
export const EXPLANATION_FAILURE_MESSAGE = 'Context explanation is currently unavailable.';

interface Attempt {
  readonly state: ExplainState;
  readonly explanation: ExplanationIpcView | null;
  readonly message: string | null;
}

const IDLE: Attempt = { state: 'idle', explanation: null, message: null };

const UNSUPPORTED: Attempt = { state: 'unsupported', explanation: null, message: null };

/** A request id with no meaning: it identifies a press, and nothing else. */
const newRequestId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `r-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

export const useExplainInContext = ({
  bridge,
  registry,
  documentId,
  request,
  result,
  loadingDelayMs = LOADING_DELAY_MS,
}: ExplainInContextOptions): ExplainControl => {
  const ai = bridge?.ai ?? null;
  // Kept with the bridge it describes, so a bridge that goes away cannot
  // leave a stale "configured" behind.
  const [asked, setAsked] = useState<{
    readonly source: DesktopBridge['ai'];
    readonly reply: AiStatusReply;
  } | null>(null);
  const status = asked !== null && asked.source === ai ? asked.reply : null;
  const [attempt, setAttempt] = useState<Attempt>(IDLE);
  const token = useRef(0);
  const inFlight = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The same live-page subscription the dictionary and save hooks use: a
  // recycled page has to reach this hook as a render, not as a stale value
  // read once (ADR-018).
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const readVersion = useCallback(() => registry.version(), [registry]);
  const liveVersion = useSyncExternalStore(subscribe, readVersion);

  // Whether a provider exists at all is asked once per bridge. It is a
  // question about this installation, not about this word.
  useEffect(() => {
    if (ai === null) {
      return;
    }

    let current = true;

    void ai
      .status()
      .then((reply) => {
        if (current) {
          setAsked({ source: ai, reply });
        }
      })
      .catch(() => {
        // Unanswerable means unsupported, which is the default.
      });

    return (): void => {
      current = false;
    };
  }, [ai]);

  /**
   * One popup, one explanation.
   *
   * Reset during render rather than in an effect, so the control never
   * shows the previous word's answer for a frame — the same reason the save
   * control is derived this way.
   *
   * The key is `null` whenever there is nothing on screen to explain: no
   * popup, another document, or a page that has since been recycled. That
   * is what turns a page recycle into the same event as closing the popup,
   * for both the display and the cancellation below.
   */
  const key = useMemo((): string | null => {
    // `liveVersion` is what makes this recompute when the live set changes;
    // the registry itself is mutable and would otherwise be read once.
    void liveVersion;

    if (request === null || documentId === null || request.documentId !== documentId) {
      return null;
    }

    const live = registry.get(request.pageNumber);

    if (live === null || live.generation !== request.generation) {
      return null;
    }

    return `${documentId}:${String(request.pageNumber)}:${String(request.generation)}:${request.word.normalized}`;
  }, [documentId, liveVersion, registry, request]);
  const [lastKey, setLastKey] = useState<string | null>(key);

  if (key !== lastKey) {
    setLastKey(key);
    setAttempt(IDLE);
  }

  /**
   * Abandoning a request that is still in flight.
   *
   * Raising the token stops a late answer being shown; it does **not** stop
   * the work. `ai:cancel` carries the same bounded request id the press
   * used, so the main process aborts the `AbortController` registered under
   * it and the provider request unwinds instead of running on for up to the
   * twenty-second timeout (investigation section 11.3).
   *
   * There is nothing to cancel once an answer has arrived: the reply
   * handler clears the id first, so a completed request is never cancelled.
   */
  const abandon = useCallback((): void => {
    token.current += 1;

    const requestId = inFlight.current;

    inFlight.current = null;

    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (requestId === null || ai === null) {
      return;
    }

    void ai.cancel(requestId).catch(() => {
      // A cancellation that cannot be delivered still stops the reader
      // waiting; the request times out on its own.
    });
  }, [ai]);

  /**
   * Word change, popup close, page recycle, document switch — and unmount.
   *
   * All five are the same event to this hook: the question the request was
   * asked about is no longer on screen. They arrive here as a change of
   * `key`, which runs this cleanup before the next render's effects, so the
   * abandoned request is cancelled with its own id rather than silently
   * dropped.
   */
  useEffect(
    () => (): void => {
      abandon();
    },
    [abandon, key],
  );

  /**
   * The passage, taken from the page as it is now.
   *
   * `null` when the page has been recycled: there is then no excerpt this
   * reader is looking at, and sending the last one we saw would be sending
   * something they are no longer reading.
   */
  const capture = useCallback((): {
    readonly context: string;
    readonly contextWordStart: number;
  } | null => {
    if (request === null || documentId === null || request.documentId !== documentId) {
      return null;
    }

    const live = registry.get(request.pageNumber);

    if (live === null || live.generation !== request.generation) {
      return null;
    }

    const joined = joinSegments(live.layer.segments);
    const excerpt = extractContext(joined.text, request.word.start, request.word.end);

    return excerpt === null
      ? null
      : { context: excerpt.context, contextWordStart: excerpt.contextWordStart };
  }, [documentId, registry, request]);

  const wordForm = useCallback(
    (): {
      readonly raw: string;
      readonly display: string;
      readonly normalized: string;
      readonly joinedAcrossLines: boolean;
    } | null =>
      request === null
        ? null
        : {
            raw: request.word.raw,
            display: request.word.display,
            normalized: request.word.normalized,
            joinedAcrossLines: request.word.joinedAcrossLines,
          },
    [request],
  );

  // Opening the popup reads what is already known. It is a read: no
  // excerpt leaves the machine, and nothing is generated.
  useEffect(() => {
    if (ai === null || status === null || !status.configured || key === null) {
      return;
    }

    const word = wordForm();
    const excerpt = capture();

    if (word === null || excerpt === null || request === null || documentId === null) {
      return;
    }

    token.current += 1;
    const issued = token.current;

    void ai
      .storedExplanation({ word, documentId, page: request.pageNumber, ...excerpt })
      .then((reply) => {
        if (token.current !== issued || reply === null) {
          return;
        }

        setAttempt({
          state: reply.status === 'current' ? 'ready' : 'stale',
          explanation: reply,
          message: null,
        });
      })
      .catch(() => {
        // Nothing stored, or nothing readable: the control simply offers
        // to explain.
      });
  }, [ai, status, key, capture, wordForm, documentId, request]);

  const onExplain = useCallback((): void => {
    if (ai === null || status === null || !status.configured || request === null) {
      return;
    }

    const word = wordForm();
    const excerpt = capture();

    if (word === null || excerpt === null || documentId === null || result === null) {
      // The page moved out from under the request: there is nothing
      // truthful to send.
      setAttempt({ state: 'failed', explanation: null, message: EXPLANATION_FAILURE_MESSAGE });

      return;
    }

    if (result.status === 'unavailable') {
      return;
    }

    const requestId = newRequestId();

    token.current += 1;
    const issued = token.current;

    inFlight.current = requestId;
    setAttempt({ state: 'pending', explanation: null, message: null });

    // A request that answers in a millisecond must not make the popup
    // flicker, so "working" only becomes visible after a moment.
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }

    timer.current = setTimeout(() => {
      if (token.current === issued) {
        setAttempt((current) =>
          current.state === 'pending' ? { ...current, state: 'loading' } : current,
        );
      }
    }, loadingDelayMs);

    void ai
      .explain({
        requestId,
        word,
        documentId,
        page: request.pageNumber,
        lookupStatus: result.status,
        ...excerpt,
      })
      .then((reply) => {
        if (token.current !== issued) {
          return;
        }

        inFlight.current = null;

        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }

        if (reply.ok) {
          setAttempt({ state: 'ready', explanation: reply.value, message: null });

          return;
        }

        if (reply.error.kind === 'cancelled') {
          // The reader asked for this to stop. Saying so would be noise.
          setAttempt(IDLE);

          return;
        }

        setAttempt(
          reply.error.kind === 'not-configured'
            ? UNSUPPORTED
            : { state: 'failed', explanation: null, message: EXPLANATION_FAILURE_MESSAGE },
        );
      })
      .catch(() => {
        if (token.current === issued) {
          inFlight.current = null;
          setAttempt({ state: 'failed', explanation: null, message: EXPLANATION_FAILURE_MESSAGE });
        }
      });
  }, [ai, capture, documentId, loadingDelayMs, request, result, status, wordForm]);

  /**
   * The Stop button: the same abandonment as a word change, with the popup
   * returned to its resting state because the reader is still looking at
   * it.
   */
  const onCancel = useCallback((): void => {
    abandon();
    setAttempt(IDLE);
  }, [abandon]);

  if (ai === null || status === null || !status.configured) {
    return {
      state: 'unsupported',
      explanation: null,
      message: null,
      destination: null,
      onExplain: (): void => {},
      onCancel: (): void => {},
    };
  }

  return {
    state: attempt.state,
    explanation: attempt.explanation,
    message: attempt.message,
    destination: status,
    onExplain,
    onCancel,
  };
};
