import { baseFormCandidates, type MorphologyPart } from './morphology';
import type { DictionaryQuery, DictionaryResolution, MorphologyTables } from './types';

/**
 * Turns one word into the ordered list of keys worth looking up.
 *
 * This is the whole fallback pipeline expressed as data: exact, then case,
 * then typographic, then morphology. Nothing here decides *what a word
 * means* — it only proposes spellings, in a fixed order, and the first
 * spelling the store can answer wins. There is no scoring, no fuzzy
 * matching and no probability.
 *
 * `normalizeWord` is not re-implemented and not modified (ADR-019): the
 * candidates derived from `raw` are additional **keys**, never an
 * alternative normalisation.
 */

export interface LookupCandidate {
  readonly key: string;
  /** The pipeline stage that proposed this key. */
  readonly stage: DictionaryResolution;
  /** Why it was proposed. Shown in diagnostics and asserted in tests. */
  readonly via: CandidateOrigin;
  /**
   * The parts of speech the morphological rules that proposed this key
   * assumed, in rule order; empty for every other stage.
   *
   * A reader who double-clicks "watched" asked about a past-tense verb, and
   * the rule that found "watch" knew that. Carrying the assumption lets the
   * pipeline show the verb before the pocket timepiece without inventing a
   * tagger: the information comes from the rule that fired, not from the
   * sentence.
   */
  readonly assumedParts: readonly MorphologyPart[];
}

export type CandidateOrigin =
  | 'normalized'
  | 'case-folded-raw'
  | 'restored-period'
  | 'dots-removed'
  | 'line-break-join'
  | 'hyphen-removed'
  | 'hyphen-to-space'
  | 'space-to-hyphen'
  | 'contraction-host'
  | 'apostrophe-removed'
  | 'base-form';

/** Upper bound on the work one lookup can cause. */
const MAXIMUM_CANDIDATES = 32;

const TYPOGRAPHIC_APOSTROPHE = /[\u2019\u02BC\u2018]/gu;
const LEADING_NON_WORD = /^[^\p{L}\p{N}]+/u;
const TRAILING_NON_WORD = /[^\p{L}\p{N}]+$/u;

/**
 * Contractions whose host word is not simply the text before the apostrophe.
 *
 * Deliberately a short, explicit table. "won't" is not "wo", and guessing
 * would be exactly the kind of invented lexical fact this subsystem must not
 * produce.
 */
const IRREGULAR_CONTRACTIONS: Readonly<Record<string, string>> = {
  "won't": 'will',
  "shan't": 'shall',
  "ain't": 'be',
  "can't": 'can',
  cannot: 'can',
};

/** Clitics that attach to a host word: `they'll`, `we've`, `I'm`, `she'd`. */
const CLITICS: readonly string[] = ["n't", "'ll", "'re", "'ve", "'m", "'d", "'s"];

/**
 * The raw page text reduced to a comparable key without normalising it.
 *
 * Whitespace (including a line break) is removed and typographic apostrophes
 * are unified, because those are artefacts of typesetting. Case is folded
 * because dictionary keys are lowercase. Nothing else is touched — in
 * particular the internal punctuation `normalizeWord` keeps and the trailing
 * punctuation it strips are both preserved here, which is what makes this
 * stage able to find `e.g.`.
 */
const caseFoldedRaw = (raw: string): string =>
  raw
    .normalize('NFC')
    .replace(/\u00AD/gu, '')
    .replace(TYPOGRAPHIC_APOSTROPHE, "'")
    .replace(/\s+/gu, '')
    .toLowerCase();

/** True when the page text ends with a full stop, as abbreviations do. */
const endsWithPeriod = (raw: string): boolean => caseFoldedRaw(raw).endsWith('.');

const trimNonWord = (value: string): string =>
  value.replace(LEADING_NON_WORD, '').replace(TRAILING_NON_WORD, '');

/**
 * The host word of a contraction, or `null`.
 *
 * `don't` → `do`, `they'll` → `they`, `won't` → `will`. The clitic itself is
 * never looked up: a reader clicking "don't" is shown the entry for "do" and
 * told so, rather than being shown a pretend entry for the contraction.
 */
export const contractionHost = (word: string): string | null => {
  const irregular = IRREGULAR_CONTRACTIONS[word];

  if (irregular !== undefined) {
    return irregular;
  }

  for (const clitic of CLITICS) {
    if (word.endsWith(clitic) && word.length > clitic.length) {
      return word.slice(0, word.length - clitic.length);
    }
  }

  return null;
};

/**
 * The ordered candidate keys for a query.
 *
 * @param query the word as identified on the page
 * @param tables morphological exception lists from the artifact
 */
export const lookupCandidates = (
  query: DictionaryQuery,
  tables: MorphologyTables,
): readonly LookupCandidate[] => {
  const candidates: {
    key: string;
    stage: DictionaryResolution;
    via: CandidateOrigin;
    assumedParts: MorphologyPart[];
  }[] = [];
  const positions = new Map<string, number>();

  const add = (
    key: string,
    stage: DictionaryResolution,
    via: CandidateOrigin,
    assumedPart?: MorphologyPart,
  ): void => {
    if (key.length === 0) {
      return;
    }

    const existing = positions.get(key);

    if (existing !== undefined) {
      // The same spelling can be proposed by several morphological rules
      // ("leaves" is a plural noun and a present-tense verb). Keep the first
      // position, but remember every assumption, so neither reading is lost.
      const candidate = candidates[existing];

      if (
        candidate !== undefined &&
        assumedPart !== undefined &&
        !candidate.assumedParts.includes(assumedPart)
      ) {
        candidate.assumedParts.push(assumedPart);
      }

      return;
    }

    if (candidates.length >= MAXIMUM_CANDIDATES) {
      return;
    }

    positions.set(key, candidates.length);
    candidates.push({
      key,
      stage,
      via,
      assumedParts: assumedPart === undefined ? [] : [assumedPart],
    });
  };

  const { normalized, raw, joinedAcrossLines } = query;

  /* 1. Exact. */
  add(normalized, 'exact', 'normalized');

  /* 2. Case. The raw text case-folded but not otherwise normalised; this
     differs from `normalized` only when compatibility folding or punctuation
     trimming changed something. */
  const folded = trimNonWord(caseFoldedRaw(raw));

  add(folded, 'case', 'case-folded-raw');

  /* 3. Typographic: artefacts of how the page was typeset. */

  // Dotted abbreviations. `normalizeWord` strips the trailing period, but
  // `e.g.` is a headword *with* it.
  if (endsWithPeriod(raw) && normalized.length > 0) {
    add(`${normalized}.`, 'typographic', 'restored-period');
  }

  if (normalized.includes('.')) {
    add(normalized.replace(/\./gu, ''), 'typographic', 'dots-removed');
  }

  // Hyphens. A word rejoined across a line break is tried both ways; the
  // hyphenated form was already proposed as the exact candidate, so when
  // both exist the hyphenated one wins by order alone (ADR-019).
  if (normalized.includes('-')) {
    add(
      normalized.replace(/-/gu, ''),
      'typographic',
      joinedAcrossLines ? 'line-break-join' : 'hyphen-removed',
    );
    add(normalized.replace(/-/gu, ' '), 'typographic', 'hyphen-to-space');
  }

  if (normalized.includes(' ')) {
    add(normalized.replace(/ /gu, '-'), 'typographic', 'space-to-hyphen');
  }

  // Contractions.
  const host = contractionHost(normalized);

  if (host !== null) {
    add(host, 'typographic', 'contraction-host');
  }

  if (normalized.includes("'")) {
    add(normalized.replace(/'/gu, ''), 'typographic', 'apostrophe-removed');
  }

  /* 4. Morphology: Morphy's exception lists and detachment rules. */
  for (const base of baseFormCandidates(normalized, tables)) {
    add(base.base, 'morphology', 'base-form', base.partOfSpeech);
  }

  // A hyphenated line break can also hide an inflection: "light-\nhouses".
  if (joinedAcrossLines && normalized.includes('-')) {
    for (const base of baseFormCandidates(normalized.replace(/-/gu, ''), tables)) {
      add(base.base, 'morphology', 'base-form', base.partOfSpeech);
    }
  }

  // The host of a contraction may itself be inflected: "doesn't" → "does" → "do".
  if (host !== null) {
    for (const base of baseFormCandidates(host, tables)) {
      add(base.base, 'morphology', 'base-form', base.partOfSpeech);
    }
  }

  return candidates;
};
