import type { DictionaryPartOfSpeech, DictionaryResolution } from '../dictionary/types';
import type { Result } from '../result';

/**
 * The contextual-explanation port.
 *
 * This file names no vendor, no wire format, no header, no endpoint and no
 * credential, and it imports nothing but types. That is the whole point: a
 * provider is replaceable if replacing it touches one adapter under
 * `src/main/ai/providers` and nothing else (ADR-005, ADR-027).
 *
 * Three rules are expressed in the shapes rather than in prose:
 *
 * - **The request is an allowlist.** It carries the word, what the local
 *   dictionary said about it, and the bounded excerpt. There is no field
 *   here that could hold a document name, a filesystem path, a document id,
 *   a page number or a timestamp, so none of them can be sent by accident.
 * - **The answer is small and typed.** Plain text, an optional index into
 *   the senses that were offered, and a flag saying the provider stopped
 *   early. No markup, no confidence score, no provider-claimed identity.
 * - **Failure is a value from a closed union.** No HTTP status, no URL, no
 *   provider message: detail belongs in main-process diagnostics, exactly
 *   as `VocabularyFailure` decided in Milestone 4.
 */

/**
 * The lookup outcomes a word can be explained from.
 *
 * `unavailable` is absent deliberately: when the dictionary cannot answer
 * at all there is no entry to ground an explanation in, and the control is
 * not offered.
 */
export type ExplainableLookupStatus = 'found' | 'partial' | 'not-found';

/** One candidate sense, as the model is allowed to see it. */
export interface PromptSense {
  readonly partOfSpeech: DictionaryPartOfSpeech;
  /** Truncated to `MAX_SENSE_DEFINITION_CHARACTERS`. */
  readonly definition: string;
}

/** What the model is asked. Assembled in core, never by the renderer. */
export interface ContextExplanationRequest {
  readonly word: { readonly display: string; readonly normalized: string };
  readonly headword: string | null;
  readonly resolvedBy: DictionaryResolution | null;
  readonly lookupStatus: ExplainableLookupStatus;
  /** At most `SENSE_LIMIT` entries, each definition truncated. May be empty. */
  readonly senses: readonly PromptSense[];
  /** The Milestone 4 excerpt, verbatim: at most `MAX_CONTEXT_CHARACTERS`. */
  readonly context: string;
  /** Where the word starts inside `context`, so the prompt can point at it. */
  readonly contextWordStart: number;
  readonly promptVersion: string;
}

/** What a provider may return. Nothing here is trusted until parsed. */
export interface ContextExplanation {
  /** Plain text. No markup, no HTML, no links. Bounded. */
  readonly text: string;
  /** Index into `request.senses`, or null when the model would not commit. */
  readonly senseIndex: number | null;
  /** True when the provider stopped early and the text may be cut. */
  readonly truncated: boolean;
}

export type AiFailure =
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly reason: 'auth' | 'rate-limited' | 'quota' | 'refused' }
  | { readonly kind: 'unusable-response'; readonly reason: 'malformed' | 'empty' | 'oversized' }
  | { readonly kind: 'provider-error' };

/** Labels the interface may disclose before anything is sent. */
export interface ProviderDescription {
  /** Adapter family plus a readable destination label. Never a credential. */
  readonly provider: string;
  readonly model: string;
  /** False only when the destination is this machine. */
  readonly remote: boolean;
}

export interface ContextExplainer {
  /** Labels the UI discloses before anything is sent. Never a credential. */
  describe(): ProviderDescription;
  /** Never throws: every outcome is a typed value. */
  explain(
    request: ContextExplanationRequest,
    signal: AbortSignal,
  ): Promise<Result<ContextExplanation, AiFailure>>;
}
