import type { DictionaryResult } from '../dictionary/types';
import type { IdentifiedWord } from '../word/types';
import { normalizeWord } from '../word/normalizeWord';

import { snapshotFrom, sourceFrom } from './snapshot';
import type {
  SaveWordRequest,
  SavedDocumentFacts,
  SavedLookupStatus,
  SavedWordForm,
} from './types';
import type { OccurrenceLocation } from './types';

/**
 * What identifies a saved word.
 *
 * Identity is `IdentifiedWord.normalized` — the output of Milestone 2's
 * `normalizeWord`, which knows nothing about any dictionary (ADR-024). The
 * dictionary headword is stored as an *attribute* so a library can group
 * `ran` with `run` later, but it can never merge, rename or delete a record
 * the reader created: a dataset upgrade must not be able to change the
 * identity of user data.
 *
 * Consequences, all intended: `ran` and `run` are two items because
 * normalisation is not lemmatisation; `Mice` and `mice` are one; `dog's` and
 * `dog` are two; `dog’s` and `dog's` are one, because the typographic
 * apostrophe is unified by the same M2 function. There is no second
 * normaliser in this module — `normalizeWord` is imported, never reimplemented.
 */

/** A word that cannot be saved, and why. */
export type IdentityRejection = 'empty-word' | 'no-answer';

/**
 * The hyphen Milestone 2 drops when it rejoins a word across a line break.
 *
 * `identifyWordAt` builds `normalized` from the two halves *without* the
 * trailing hyphen of the first one, so `recon-\nsidered` looks up as
 * `reconsidered`. Normalising the raw text alone would leave the hyphen in
 * place and produce a different identity from the one the dictionary was
 * asked about, so the same rule is applied here.
 */
const LINE_BREAK_HYPHEN = /-(?=\s)/u;

/**
 * Recomputes the identity of a word from the characters on the page.
 *
 * Deliberately not `word.normalized`: identity is derived, not accepted, so
 * nothing on the far side of a process boundary can decide what a saved word
 * is called.
 */
export const normalizedIdentityOf = (word: IdentifiedWord): string =>
  normalizeWord(word.joinedAcrossLines ? word.raw.replace(LINE_BREAK_HYPHEN, '') : word.raw);

export type SavedWordIdentity =
  | { readonly ok: true; readonly form: SavedWordForm; readonly status: SavedLookupStatus }
  | { readonly ok: false; readonly reason: IdentityRejection };

/**
 * Derives the stored word forms from the word the reader interacted with.
 *
 * `raw` is passed through untouched — it is the only field that still holds
 * exactly what the page says, newline and all. `normalized` is recomputed
 * from `raw` rather than trusted, so a caller on the far side of an IPC
 * boundary cannot invent an identity.
 */
export const identifyForSaving = (
  word: IdentifiedWord,
  result: DictionaryResult,
): SavedWordIdentity => {
  const normalized = normalizedIdentityOf(word);

  if (normalized.length === 0) {
    return { ok: false, reason: 'empty-word' };
  }

  if (result.status === 'unavailable') {
    // Nothing was shown to the reader, so there is nothing to preserve.
    return { ok: false, reason: 'no-answer' };
  }

  return {
    ok: true,
    form: {
      raw: word.raw,
      display: word.display,
      normalized,
      joinedAcrossLines: word.joinedAcrossLines,
    },
    status: result.status,
  };
};

/** The definition the card shows and tier-2 search looks inside. */
export const shortDefinitionFrom = (result: DictionaryResult): string | null => {
  if (result.status !== 'found' && result.status !== 'partial') {
    return null;
  }

  return result.senses[0]?.definition ?? null;
};

/**
 * Assembles a complete save request from what the renderer had on screen.
 *
 * Everything persisted is derived here, in one pure function, so the main
 * process and the renderer cannot disagree about what a save means.
 */
export const buildSaveRequest = (
  word: IdentifiedWord,
  result: DictionaryResult,
  document: SavedDocumentFacts,
  occurrence: OccurrenceLocation,
  transformVersion: string,
): SaveWordRequest | null => {
  const identity = identifyForSaving(word, result);

  if (!identity.ok) {
    return null;
  }

  const answered = result.status === 'found' || result.status === 'partial';

  return {
    word: identity.form,
    document,
    occurrence,
    headword: answered ? result.headword : null,
    resolvedBy: answered ? result.resolvedBy : null,
    lookupStatus: identity.status,
    shortDefinition: shortDefinitionFrom(result),
    snapshot: snapshotFrom(result),
    source: sourceFrom(result, transformVersion),
  };
};
