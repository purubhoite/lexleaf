import { MAX_CONTEXT_CHARACTERS } from '../vocabulary/context';

/**
 * Every bound the explanation feature obeys, in one place.
 *
 * These are not tuning knobs. Each one closes a specific hole: what may
 * leave the machine, how much attacker-controlled text can reach a model,
 * how large a reply may be before it is a memory problem, and how long a
 * reader may be left waiting. They live in core so that the prompt builder,
 * the parser, the provider adapter and the service all enforce the same
 * numbers, and so that a test can read them from the same source the code
 * does.
 *
 * `MAX_CONTEXT_CHARACTERS` is re-exported rather than redefined: the excerpt
 * cap is Milestone 4's (ADR-026), enforced by `extractContext` and again by
 * a `CHECK` in the schema. A second definition could drift from it.
 */

export { MAX_CONTEXT_CHARACTERS };

/** At most this many dictionary senses are offered to the model. */
export const SENSE_LIMIT = 6;

/** Each offered definition is truncated to this many characters. */
export const MAX_SENSE_DEFINITION_CHARACTERS = 200;

/** Hard ceiling on the assembled prompt, after every other cap. */
export const MAX_PROMPT_CHARACTERS = 4000;

/** The longest explanation that may be stored or displayed. */
export const MAX_EXPLANATION_CHARACTERS = 2000;

/** Reading stops at this many bytes; a longer body is `oversized`. */
export const MAX_RESPONSE_BYTES = 32768;

/** A request that has not answered by now is a `timeout`. */
export const REQUEST_TIMEOUT_MS = 20000;

/** Explanations for words that were never saved, kept in memory only. */
export const EXPLANATION_CACHE_ENTRIES = 32;
