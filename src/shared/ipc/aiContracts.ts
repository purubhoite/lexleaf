import { MAX_CONTEXT_CHARACTERS, MAX_EXPLANATION_CHARACTERS } from '@core/ai/limits';
import type { AiFailure, ExplainableLookupStatus } from '@core/ai/types';
import type { Result } from '@core/result';
import type { SavedWordForm } from '@core/vocabulary/types';

/**
 * What the four AI channels carry, and how it is checked.
 *
 * The shapes here are the reason a compromised renderer cannot turn this
 * feature into a general-purpose uploader. Read what is **not** in them:
 * no URL, no endpoint, no host, no header, no credential, no model name,
 * no prompt, no instruction, no temperature, no provider selection. The
 * renderer names a word, where it was met and the excerpt it already has
 * on screen; everything else is decided in the main process.
 *
 * Both directions are parsed, for the same reasons as the vocabulary
 * contracts: the renderer is untrusted input to the main process, and a
 * renderer should not have to defend itself against malformed replies
 * either.
 */

/** The longest word any AI channel will consider, matching the dictionary's. */
export const MAXIMUM_AI_WORD_LENGTH = 128;

/** Bounds a request id so a map key cannot become a workload. */
export const MAXIMUM_REQUEST_ID_LENGTH = 64;

export interface ExplainIpcRequest {
  readonly requestId: string;
  readonly word: SavedWordForm;
  readonly documentId: string;
  readonly page: number;
  /** What the popup was showing. `unavailable` has no Explain control. */
  readonly lookupStatus: ExplainableLookupStatus;
  /** The excerpt the popup captured at click time. */
  readonly context: string;
  readonly contextWordStart: number;
}

export interface StoredExplanationIpcQuery {
  readonly word: SavedWordForm;
  readonly documentId: string;
  readonly page: number;
  readonly context: string;
  readonly contextWordStart: number;
}

/** What the popup may show before anything is sent. Labels only. */
export interface AiStatusReply {
  readonly configured: boolean;
  readonly provider: string;
  readonly model: string;
  readonly remote: boolean;
}

export interface ExplanationIpcView {
  readonly text: string;
  readonly senseIndex: number | null;
  readonly truncated: boolean;
  readonly createdAt: string;
  readonly provider: string;
  readonly model: string;
  readonly remote: boolean;
  readonly status: 'current' | 'previous-context';
}

export type AiIpcResult<T> = Result<T, AiFailure>;

/** The reply when nothing is configured; also the fallback for a bad reply. */
export const AI_UNCONFIGURED: AiStatusReply = {
  configured: false,
  provider: 'none',
  model: 'none',
  remote: false,
};

const LOOKUP_STATUSES: readonly ExplainableLookupStatus[] = ['found', 'partial', 'not-found'];

const REJECTION_REASONS: readonly string[] = ['auth', 'rate-limited', 'quota', 'refused'];

const UNUSABLE_REASONS: readonly string[] = ['malformed', 'empty', 'oversized'];

const REQUEST_ID = /^[A-Za-z0-9_:-]+$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isPageNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const parseWordForm = (value: unknown): SavedWordForm | null => {
  if (!isObject(value)) {
    return null;
  }

  const raw = value['raw'];
  const display = value['display'];
  const normalized = value['normalized'];
  const joined = value['joinedAcrossLines'];

  if (
    !isText(raw, MAXIMUM_AI_WORD_LENGTH) ||
    !isText(display, MAXIMUM_AI_WORD_LENGTH) ||
    !isText(normalized, MAXIMUM_AI_WORD_LENGTH) ||
    typeof joined !== 'boolean'
  ) {
    return null;
  }

  return { raw, display, normalized, joinedAcrossLines: joined };
};

/**
 * The excerpt, bounded exactly as the database bounds it.
 *
 * A renderer cannot send more text than Milestone 4 would have stored, so
 * this channel cannot become a way to move a page - or a document -
 * outwards in pieces any faster than the page text it already holds.
 */
const parseContext = (
  value: unknown,
  offset: unknown,
): { readonly context: string; readonly contextWordStart: number } | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONTEXT_CHARACTERS) {
    return null;
  }

  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    return null;
  }

  return { context: value, contextWordStart: Math.min(offset, value.length) };
};

export const parseExplainRequest = (value: unknown): ExplainIpcRequest | null => {
  if (!isObject(value)) {
    return null;
  }

  const requestId = value['requestId'];
  const word = parseWordForm(value['word']);
  const documentId = value['documentId'];
  const page = value['page'];
  const lookupStatus = LOOKUP_STATUSES.find((candidate) => candidate === value['lookupStatus']);
  const excerpt = parseContext(value['context'], value['contextWordStart']);

  if (
    !isText(requestId, MAXIMUM_REQUEST_ID_LENGTH) ||
    !REQUEST_ID.test(requestId) ||
    word === null ||
    !isText(documentId, 128) ||
    !isPageNumber(page) ||
    lookupStatus === undefined ||
    excerpt === null
  ) {
    return null;
  }

  return { requestId, word, documentId, page, lookupStatus, ...excerpt };
};

export const parseStoredExplanationQuery = (value: unknown): StoredExplanationIpcQuery | null => {
  if (!isObject(value)) {
    return null;
  }

  const word = parseWordForm(value['word']);
  const documentId = value['documentId'];
  const page = value['page'];
  const excerpt = parseContext(value['context'], value['contextWordStart']);

  if (word === null || !isText(documentId, 128) || !isPageNumber(page) || excerpt === null) {
    return null;
  }

  return { word, documentId, page, ...excerpt };
};

export const parseRequestId = (value: unknown): string | null => {
  const candidate = isObject(value) ? value['requestId'] : value;

  return isText(candidate, MAXIMUM_REQUEST_ID_LENGTH) && REQUEST_ID.test(candidate)
    ? candidate
    : null;
};

/* Replies, parsed on the way back into the renderer. */

export const parseAiStatus = (value: unknown): AiStatusReply | null => {
  if (!isObject(value)) {
    return null;
  }

  const provider = value['provider'];
  const model = value['model'];

  if (
    typeof value['configured'] !== 'boolean' ||
    typeof value['remote'] !== 'boolean' ||
    !isText(provider, 128) ||
    !isText(model, 128)
  ) {
    return null;
  }

  return {
    configured: value['configured'],
    provider,
    model,
    remote: value['remote'],
  };
};

export const parseExplanationView = (value: unknown): ExplanationIpcView | null => {
  if (!isObject(value)) {
    return null;
  }

  const text = value['text'];
  const createdAt = value['createdAt'];
  const provider = value['provider'];
  const model = value['model'];
  const status = value['status'];
  const senseIndex = value['senseIndex'];

  if (
    !isText(text, MAX_EXPLANATION_CHARACTERS) ||
    !isText(createdAt, 64) ||
    !isText(provider, 128) ||
    !isText(model, 128) ||
    typeof value['truncated'] !== 'boolean' ||
    typeof value['remote'] !== 'boolean' ||
    (status !== 'current' && status !== 'previous-context')
  ) {
    return null;
  }

  return {
    text,
    senseIndex:
      typeof senseIndex === 'number' && Number.isInteger(senseIndex) && senseIndex >= 0
        ? senseIndex
        : null,
    truncated: value['truncated'],
    createdAt,
    provider,
    model,
    remote: value['remote'],
    status,
  };
};

const parseFailure = (value: unknown): AiFailure | null => {
  if (!isObject(value)) {
    return null;
  }

  const kind = value['kind'];

  if (
    kind === 'not-configured' ||
    kind === 'offline' ||
    kind === 'timeout' ||
    kind === 'cancelled' ||
    kind === 'provider-error'
  ) {
    return { kind };
  }

  const reason = value['reason'];

  if (kind === 'rejected' && typeof reason === 'string' && REJECTION_REASONS.includes(reason)) {
    return { kind, reason: reason as 'auth' | 'rate-limited' | 'quota' | 'refused' };
  }

  if (
    kind === 'unusable-response' &&
    typeof reason === 'string' &&
    UNUSABLE_REASONS.includes(reason)
  ) {
    return { kind, reason: reason as 'malformed' | 'empty' | 'oversized' };
  }

  return null;
};

export const parseExplanationResult = (value: unknown): AiIpcResult<ExplanationIpcView> | null => {
  if (!isObject(value)) {
    return null;
  }

  if (value['ok'] === true) {
    const parsed = parseExplanationView(value['value']);

    return parsed === null ? null : { ok: true, value: parsed };
  }

  if (value['ok'] !== false) {
    return null;
  }

  const failure = parseFailure(value['error']);

  return failure === null ? null : { ok: false, error: failure };
};
