/**
 * What makes two explanations the same question.
 *
 * An explanation answers "how is *this word* used in *this passage*, asked
 * of *this configuration*". Every part of that sentence is identity, and
 * nothing else is:
 *
 * | In the key | Not in the key |
 * | --- | --- |
 * | item (or normalized word, before a save) | `source_id` |
 * | document id | char anchors, `pageOffsetFraction` |
 * | page | `created_at`, `senseIndex`, `truncated` |
 * | context hash (excerpt **and** the offset of the word inside it) | saved/unsaved state |
 * | prompt version, provider id, model id | |
 *
 * The offset matters as much as the excerpt: `… charge the charge and then
 * charge again …` can produce a byte-identical 240-character window for two
 * different instances of the word, and hashing the excerpt alone would show
 * the first instance's answer for the second.
 *
 * Hashing itself is not done here. Core stays free of `node:crypto`, so the
 * canonical encoding is built here and the digest is taken in the main
 * process (`src/main/ai/digest.ts`), which keeps this module pure and the
 * encoding directly testable.
 */

/**
 * The canonical-encoding version.
 *
 * Separate from `PROMPT_VERSION` and not to be conflated with it: this
 * names the *layout* below. Changing the layout invalidates stored matches
 * by construction — old rows simply stop matching and become
 * previous-context explanations. They are never rewritten.
 */
export const CONTEXT_ENCODING_VERSION = 'v1';

/**
 * The exact bytes the context hash is taken over.
 *
 * The explicit length line is what makes the encoding unforgeable: an
 * excerpt containing a newline cannot impersonate the end of the field,
 * because the reader of this format knows how many code units to expect.
 * The context is appended verbatim — no trimming, no case folding, no
 * Unicode normalisation — because the question put to the model was about
 * exactly those characters.
 */
export const canonicalContextEncoding = (context: string, contextWordStart: number): string =>
  [
    CONTEXT_ENCODING_VERSION,
    String(Math.trunc(contextWordStart)),
    String(context.length),
    context,
  ].join('\n');

/** The seven dimensions, together. */
export interface ExplanationIdentity {
  /** The item id for a saved word, or the normalized word before a save. */
  readonly wordKey: string;
  readonly documentId: string;
  readonly page: number;
  readonly contextHash: string;
  readonly promptVersion: string;
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * A single string key for the in-memory cache.
 *
 * `U+001F` (unit separator) joins the parts: it cannot occur in a document
 * id, a hash, a version or a model id, so no combination of values can
 * impersonate another.
 */
export const explanationKey = (identity: ExplanationIdentity): string =>
  [
    identity.wordKey,
    identity.documentId,
    String(identity.page),
    identity.contextHash,
    identity.promptVersion,
    identity.providerId,
    identity.modelId,
  ].join('\u001f');

/** True when two identities are the same question. */
export const sameIdentity = (left: ExplanationIdentity, right: ExplanationIdentity): boolean =>
  explanationKey(left) === explanationKey(right);
