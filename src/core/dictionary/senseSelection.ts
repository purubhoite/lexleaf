import type { StoredEntry, StoredSense } from './types';

/**
 * Deterministic case suppression.
 *
 * WordNet stores "He" (helium), "At" (astatine), "A" (ångström) and "Best"
 * (a physiologist) under the same lowercase keys as the commonest words in
 * English. A reader who clicks "he" and is told it is a chemical element has
 * been given a technically correct and completely useless answer, which this
 * project treats as a defect (ADR-019).
 *
 * The rule uses only two inputs — the spelling the source itself records for
 * each sense, and the characters on the page — and is therefore explainable
 * and testable. There is no classifier and no ranking model:
 *
 * 1. if the page text carries an uppercase letter anywhere but the first
 *    position ("US", "NASA", "iPhone"), nothing is suppressed: the writer
 *    clearly did not mean an ordinary word;
 * 2. otherwise, if the entry has senses whose source spelling is lowercase,
 *    only those are shown — a capitalised sense of a word that also has an
 *    ordinary sense is suppressed;
 * 3. otherwise the entry is genuinely a proper noun or a symbol ("London"),
 *    and all of its senses are kept — unless the curated closed-class layer
 *    covers the word, in which case the grammatical answer is the only
 *    useful one and the capitalised senses are dropped.
 *
 * Sentence-initial capitalisation is indistinguishable from a proper noun
 * without the surrounding sentence, which this subsystem deliberately never
 * receives. Rule 2 therefore applies regardless of the first letter's case;
 * the cost is that a capitalised sense is not shown when an ordinary one
 * exists, which is the trade this project has chosen and documented.
 */

export interface SenseSelection {
  readonly senses: readonly StoredSense[];
  /** How many senses the rule removed, for diagnostics and tests. */
  readonly suppressed: number;
}

const INTERNAL_UPPERCASE = /\p{Lu}/u;

/** True when the source spelling of a sense begins with a capital letter. */
export const isCapitalisedSense = (sense: StoredSense): boolean => {
  const first = sense.writtenForm.slice(0, 1);

  return first.length > 0 && first !== first.toLowerCase();
};

/**
 * @param entry the stored entry for the key that matched
 * @param raw the characters as they appear on the page
 * @param closedClassCovers whether the curated layer answers this key
 */
export const selectSenses = (
  entry: StoredEntry,
  raw: string,
  closedClassCovers: boolean,
): SenseSelection => {
  const trimmed = raw.trim();

  if (INTERNAL_UPPERCASE.test(trimmed.slice(1))) {
    return { senses: entry.senses, suppressed: 0 };
  }

  const ordinary = entry.senses.filter((sense) => !isCapitalisedSense(sense));

  if (ordinary.length > 0) {
    return { senses: ordinary, suppressed: entry.senses.length - ordinary.length };
  }

  if (closedClassCovers) {
    return { senses: [], suppressed: entry.senses.length };
  }

  return { senses: entry.senses, suppressed: 0 };
};
