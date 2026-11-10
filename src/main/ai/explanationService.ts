import { explanationKey, type ExplanationIdentity } from '@core/ai/identity';
import { EXPLANATION_CACHE_ENTRIES, REQUEST_TIMEOUT_MS, SENSE_LIMIT } from '@core/ai/limits';
import { buildExplanationRequest } from '@core/ai/prompt';
import type {
  AiFailure,
  ContextExplainer,
  ContextExplanation,
  ExplainableLookupStatus,
  PromptSense,
} from '@core/ai/types';
import type {
  DictionaryQuery,
  DictionaryResolution,
  DictionaryResult,
} from '@core/dictionary/types';
import { err, ok, type Result } from '@core/result';

import type { ExplanationStore, StoredExplanation } from '../vocabulary/explanationStore';

import { CANCELLED_ABORT_REASON, TIMEOUT_ABORT_REASON } from './abort';
import { contextHash } from './digest';

/**
 * The explanation feature, orchestrated in one place.
 *
 * Everything the renderer cannot be trusted with lives here: which
 * endpoint is called, what the prompt says, whether a stored answer counts
 * as a hit, when a request is abandoned, and what is written to disk.
 *
 * The decisions this module exists to keep:
 *
 * - **Nothing is sent that was not asked for.** One press, one request.
 *   There is no prefetch, no warm-up, no background regeneration and no
 *   automatic retry. A stored answer for the identical question is
 *   returned without touching the network.
 * - **A hit is all seven dimensions or it is not a hit.** A row for the
 *   same word on the same page but a different excerpt is offered only as
 *   a *previous* explanation, labelled, never as the answer.
 * - **Explaining never saves.** A word that is not in the vocabulary gets
 *   its explanation in a bounded main-memory cache that is lost on quit.
 *   If the reader later saves the word, the cached answer is promoted into
 *   a row - a consequence of the save they asked for, never a cause of
 *   one.
 * - **One request at a time, and it can always be abandoned.** A new
 *   request cancels the previous one; a timeout and a cancellation are
 *   distinguishable, because one is a failure and the other is not.
 * - **Failures are not content.** They are never stored.
 */

export interface ExplanationWord {
  readonly raw: string;
  readonly display: string;
  readonly normalized: string;
  readonly joinedAcrossLines: boolean;
}

/** What the renderer may ask to have explained. */
export interface ExplainCommand {
  readonly requestId: string;
  readonly word: ExplanationWord;
  readonly documentId: string;
  readonly page: number;
  /** What the popup was showing; `unavailable` cannot reach here. */
  readonly lookupStatus: ExplainableLookupStatus;
  readonly context: string;
  readonly contextWordStart: number;
}

/** A read, with no possibility of a network call. */
export interface StoredExplanationQuery {
  readonly word: ExplanationWord;
  readonly documentId: string;
  readonly page: number;
  readonly context: string;
  readonly contextWordStart: number;
}

/** What crosses back to the renderer. No provider detail, ever. */
export interface ExplanationView {
  readonly text: string;
  readonly senseIndex: number | null;
  readonly truncated: boolean;
  /** ISO 8601, so the popup can say when an older answer was generated. */
  readonly createdAt: string;
  /** Destination label, never a URL. */
  readonly provider: string;
  readonly model: string;
  readonly remote: boolean;
  /** `previous-context` means: generated for an earlier version of this passage. */
  readonly status: 'current' | 'previous-context';
}

export interface AiStatus {
  readonly configured: boolean;
  readonly provider: string;
  readonly model: string;
  readonly remote: boolean;
}

/** Identifies the occurrence a save produced, for promotion. */
export interface PromotionRequest {
  readonly itemId: string;
  readonly normalized: string;
  readonly documentId: string;
  readonly page: number;
}

export interface ExplanationService {
  status(): AiStatus;
  /** Reads what is already known. Never calls a provider. */
  stored(query: StoredExplanationQuery): ExplanationView | null;
  explain(command: ExplainCommand): Promise<Result<ExplanationView, AiFailure>>;
  cancel(requestId: string): void;
  /** Called after the vocabulary save path succeeded, never before. */
  promote(request: PromotionRequest): void;
  close(): void;
}

export interface ExplanationServiceOptions {
  readonly explainer: ContextExplainer;
  /** True once a provider is configured; false hides the feature entirely. */
  readonly configured: boolean;
  /** Configuration fingerprint. Part of identity; never a URL or a key. */
  readonly providerId: string;
  readonly modelId: string;
  /** The explanation store, or `null` when the database is unavailable. */
  readonly store: () => ExplanationStore | null;
  /** The saved item for this word and place, or `null` when it is unsaved. */
  readonly resolveItemId: (normalized: string, documentId: string, page: number) => string | null;
  /** The local dictionary, consulted in main so senses are not renderer-supplied. */
  readonly lookUp: (query: DictionaryQuery) => DictionaryResult;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  readonly onDiagnostic?: (message: string) => void;
}

interface CachedExplanation {
  readonly identity: ExplanationIdentity;
  readonly explanation: ContextExplanation;
  readonly createdAt: string;
}

interface InFlight {
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
}

const UNSAVED_PREFIX = 'word:';

const sensesFrom = (result: DictionaryResult): readonly PromptSense[] =>
  result.status === 'found' || result.status === 'partial'
    ? result.senses.slice(0, SENSE_LIMIT).map((sense) => ({
        partOfSpeech: sense.partOfSpeech,
        definition: sense.definition,
      }))
    : [];

const headwordFrom = (result: DictionaryResult): string | null =>
  result.status === 'found' || result.status === 'partial' ? result.headword : null;

const resolutionFrom = (result: DictionaryResult): DictionaryResolution | null =>
  result.status === 'found' || result.status === 'partial' ? result.resolvedBy : null;

const statusFrom = (
  result: DictionaryResult,
  claimed: ExplainableLookupStatus,
): ExplainableLookupStatus => {
  if (result.status === 'found' || result.status === 'partial' || result.status === 'not-found') {
    return result.status;
  }

  // The dictionary has become unavailable since the popup opened. The word
  // can still be explained, with no senses to ground it; the renderer's
  // claim is a bounded enum, so it is safe to fall back to.
  return claimed;
};

export const createExplanationService = ({
  explainer,
  configured,
  providerId,
  modelId,
  store,
  resolveItemId,
  lookUp,
  now = (): string => new Date().toISOString(),
  timeoutMs = REQUEST_TIMEOUT_MS,
  onDiagnostic = (): void => {},
}: ExplanationServiceOptions): ExplanationService => {
  /**
   * Explanations for words that were never saved.
   *
   * Bounded, main-memory, discarded on quit — the same deliberate
   * non-durability as Milestone 4's undo slot. Least-recently-used wins
   * because the reader is most likely to press Explain again on a word
   * they are still looking at.
   */
  const unsaved = new Map<string, CachedExplanation>();
  const inFlight = new Map<string, InFlight>();
  let closed = false;

  const remember = (key: string, entry: CachedExplanation): void => {
    unsaved.delete(key);
    unsaved.set(key, entry);

    while (unsaved.size > EXPLANATION_CACHE_ENTRIES) {
      const oldest = unsaved.keys().next();

      if (oldest.done === true) {
        return;
      }

      unsaved.delete(oldest.value);
    }
  };

  const recall = (key: string): CachedExplanation | null => {
    const entry = unsaved.get(key);

    if (entry === undefined) {
      return null;
    }

    unsaved.delete(key);
    unsaved.set(key, entry);

    return entry;
  };

  const description = explainer.describe();

  const view = (
    explanation: ContextExplanation,
    createdAt: string,
    status: 'current' | 'previous-context',
  ): ExplanationView => ({
    text: explanation.text,
    senseIndex: explanation.senseIndex,
    truncated: explanation.truncated,
    createdAt,
    provider: description.provider,
    model: description.model,
    remote: description.remote,
    status,
  });

  const viewOfRow = (
    row: StoredExplanation,
    status: 'current' | 'previous-context',
  ): ExplanationView =>
    view(
      { text: row.explanation, senseIndex: row.senseIndex, truncated: row.truncated },
      row.createdAt,
      status,
    );

  /** Everything the identity of a question depends on, computed once. */
  const prepare = (
    word: ExplanationWord,
    documentId: string,
    page: number,
    context: string,
    contextWordStart: number,
    claimed: ExplainableLookupStatus,
  ): {
    readonly request: ReturnType<typeof buildExplanationRequest>;
    readonly identity: ExplanationIdentity;
    readonly itemId: string | null;
  } => {
    const result = lookUp({
      normalized: word.normalized,
      raw: word.raw,
      joinedAcrossLines: word.joinedAcrossLines,
    });

    const request = buildExplanationRequest({
      display: word.display,
      normalized: word.normalized,
      headword: headwordFrom(result),
      resolvedBy: resolutionFrom(result),
      lookupStatus: statusFrom(result, claimed),
      senses: sensesFrom(result),
      context,
      contextWordStart,
    });

    const itemId = resolveItemId(word.normalized, documentId, page);

    return {
      request,
      itemId,
      identity: {
        wordKey: itemId ?? `${UNSAVED_PREFIX}${word.normalized}`,
        documentId,
        page,
        // Hashed over what will actually be sent, after the caps were
        // applied, so a stored row always matches a question that was
        // really asked.
        contextHash: contextHash(request.context, request.contextWordStart),
        promptVersion: request.promptVersion,
        providerId,
        modelId,
      },
    };
  };

  const storedFor = (
    identity: ExplanationIdentity,
    itemId: string | null,
  ): ExplanationView | null => {
    if (itemId !== null) {
      const durable = store();

      if (durable === null) {
        return null;
      }

      const exact = durable.findExact({ ...identity, itemId });

      if (exact !== null) {
        return viewOfRow(exact, 'current');
      }

      const previous = durable.findPrevious({
        itemId,
        documentId: identity.documentId,
        page: identity.page,
      });

      return previous === null ? null : viewOfRow(previous, 'previous-context');
    }

    const cached = recall(explanationKey(identity));

    if (cached !== null) {
      return view(cached.explanation, cached.createdAt, 'current');
    }

    // A cached answer for the same word and place but another excerpt may
    // be disclosed as an earlier one, never substituted for this question.
    for (const entry of [...unsaved.values()].reverse()) {
      if (
        entry.identity.wordKey === identity.wordKey &&
        entry.identity.documentId === identity.documentId &&
        entry.identity.page === identity.page
      ) {
        return view(entry.explanation, entry.createdAt, 'previous-context');
      }
    }

    return null;
  };

  const settle = (requestId: string): void => {
    const running = inFlight.get(requestId);

    if (running === undefined) {
      return;
    }

    clearTimeout(running.timer);
    inFlight.delete(requestId);
  };

  const abortAll = (reason: string): void => {
    for (const [requestId, running] of [...inFlight.entries()]) {
      clearTimeout(running.timer);
      running.controller.abort(reason);
      inFlight.delete(requestId);
    }
  };

  const persist = (
    identity: ExplanationIdentity,
    itemId: string | null,
    explanation: ContextExplanation,
  ): string => {
    if (itemId === null) {
      const createdAt = now();

      remember(explanationKey(identity), { identity, explanation, createdAt });

      return createdAt;
    }

    const durable = store();

    if (durable === null) {
      return now();
    }

    try {
      const row = durable.insert({
        itemId,
        documentId: identity.documentId,
        page: identity.page,
        contextHash: identity.contextHash,
        promptVersion: identity.promptVersion,
        providerId: identity.providerId,
        modelId: identity.modelId,
        explanation: explanation.text,
        senseIndex: explanation.senseIndex,
        truncated: explanation.truncated,
      });

      return row?.createdAt ?? now();
    } catch (error) {
      // An explanation that could not be written is still an explanation
      // the reader can see; losing the row is not worth losing the answer.
      onDiagnostic(
        `an explanation could not be stored: ${error instanceof Error ? error.name : 'unknown error'}`,
      );

      return now();
    }
  };

  return {
    status: (): AiStatus => ({
      configured,
      provider: description.provider,
      model: description.model,
      remote: description.remote,
    }),

    stored: (query): ExplanationView | null => {
      if (!configured || closed) {
        return null;
      }

      const { identity, itemId } = prepare(
        query.word,
        query.documentId,
        query.page,
        query.context,
        query.contextWordStart,
        'not-found',
      );

      return storedFor(identity, itemId);
    },

    explain: async (command): Promise<Result<ExplanationView, AiFailure>> => {
      if (!configured || closed) {
        return err({ kind: 'not-configured' });
      }

      const { request, identity, itemId } = prepare(
        command.word,
        command.documentId,
        command.page,
        command.context,
        command.contextWordStart,
        command.lookupStatus,
      );

      const existing = storedFor(identity, itemId);

      if (existing !== null && existing.status === 'current') {
        return ok(existing);
      }

      // One in-flight request per window: pressing Explain on another word
      // abandons the previous call rather than racing it.
      abortAll(CANCELLED_ABORT_REASON);

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(TIMEOUT_ABORT_REASON);
      }, timeoutMs);

      inFlight.set(command.requestId, { controller, timer });

      const started = Date.now();
      const result = await explainer.explain(request, controller.signal);

      settle(command.requestId);

      const elapsed = Date.now() - started;

      if (!result.ok) {
        // Failures are never stored: a timeout is not an explanation.
        onDiagnostic(
          `explanation ${command.requestId} failed (${result.error.kind}) in ${String(elapsed)} ms ` +
            `[provider ${providerId} model ${modelId} prompt ${identity.promptVersion} ` +
            `${String(request.context.length)} context characters]`,
        );

        return result;
      }

      const createdAt = persist(identity, itemId, result.value);

      onDiagnostic(
        `explanation ${command.requestId} ready in ${String(elapsed)} ms ` +
          `[provider ${providerId} model ${modelId} prompt ${identity.promptVersion} ` +
          `${String(request.context.length)} context characters]`,
      );

      return ok(view(result.value, createdAt, 'current'));
    },

    cancel: (requestId): void => {
      const running = inFlight.get(requestId);

      if (running === undefined) {
        return;
      }

      clearTimeout(running.timer);
      running.controller.abort(CANCELLED_ABORT_REASON);
      inFlight.delete(requestId);
    },

    promote: ({ itemId, normalized, documentId, page }): void => {
      const durable = store();

      if (durable === null) {
        return;
      }

      const unsavedKey = `${UNSAVED_PREFIX}${normalized}`;

      for (const [key, entry] of [...unsaved.entries()]) {
        if (
          entry.identity.wordKey !== unsavedKey ||
          entry.identity.documentId !== documentId ||
          entry.identity.page !== page
        ) {
          continue;
        }

        try {
          durable.insert({
            itemId,
            documentId,
            page,
            contextHash: entry.identity.contextHash,
            promptVersion: entry.identity.promptVersion,
            providerId: entry.identity.providerId,
            modelId: entry.identity.modelId,
            explanation: entry.explanation.text,
            senseIndex: entry.explanation.senseIndex,
            truncated: entry.explanation.truncated,
          });
          // Dropped only once the row exists; a failed insert leaves the
          // reader's visible explanation where it is.
          unsaved.delete(key);
        } catch (error) {
          onDiagnostic(
            `an explanation could not be promoted: ${error instanceof Error ? error.name : 'unknown error'}`,
          );
        }
      }
    },

    close: (): void => {
      closed = true;
      abortAll(CANCELLED_ABORT_REASON);
      unsaved.clear();
    },
  };
};
