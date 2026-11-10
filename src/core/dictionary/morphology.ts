import type { MorphologyTables } from './types';

/**
 * Morphy: WordNet's own morphological fallback, as rules and tables.
 *
 * Two mechanisms, both deterministic and both derived from the source
 * release:
 *
 * 1. **exception lists** shipped with the data (`noun.exc`, `verb.exc`,
 *    `adj.exc`, `adv.exc`) — "ran run", "geese goose", "mice mouse";
 * 2. **suffix detachment rules** — a short, fixed table applied in WordNet's
 *    own order, plus the doubled-consonant rule English spelling requires.
 *
 * There is no stemmer, no tagger, no statistical model and no dependency.
 * This module proposes *spellings* together with the part of speech the rule
 * assumes; whether such a word exists is decided by the store, so a rule can
 * never invent a word, and the assumed part of speech lets the caller reject
 * a base form the data does not support ("morning" is not an inflection of
 * the noun "morn").
 */

/** The parts of speech Morphy's rules are defined for. */
export type MorphologyPart = 'noun' | 'verb' | 'adjective' | 'adverb';

export type MorphologyOrigin = 'possessive' | 'exception' | 'detachment' | 'doubled-consonant';

export interface BaseFormCandidate {
  readonly base: string;
  /** The part of speech the rule assumes the base form has. */
  readonly partOfSpeech: MorphologyPart;
  readonly origin: MorphologyOrigin;
  /** The suffix that was removed, empty for exception lists and possessives. */
  readonly suffix: string;
}

/** Suffix detachment rules, in WordNet's order: [suffix, replacement]. */
const DETACHMENT_RULES: Readonly<Record<MorphologyPart, readonly (readonly [string, string])[]>> = {
  noun: [
    ['ses', 's'],
    ['xes', 'x'],
    ['zes', 'z'],
    ['ches', 'ch'],
    ['shes', 'sh'],
    ['men', 'man'],
    ['ies', 'y'],
    ['s', ''],
  ],
  verb: [
    ['ies', 'y'],
    ['es', 'e'],
    ['es', ''],
    ['ed', 'e'],
    ['ed', ''],
    ['ing', 'e'],
    ['ing', ''],
    ['s', ''],
  ],
  adjective: [
    ['er', ''],
    ['est', ''],
    ['er', 'e'],
    ['est', 'e'],
  ],
  adverb: [],
};

/** `dog's`, `dogs'` — punctuation rather than morphology, so stripped first. */
const POSSESSIVE = /(?:'s|s')$/u;

/** `running` → `run`, `stopped` → `stop`. */
const DOUBLED_CONSONANT = /^(.*[aeiou])([bdfglmnprt])\2(ing|ed)$/u;

const MINIMUM_BASE_LENGTH = 2;

const PART_ORDER: readonly MorphologyPart[] = ['noun', 'verb', 'adjective', 'adverb'];

const tableFor = (
  tables: MorphologyTables,
  part: MorphologyPart,
): ReadonlyMap<string, readonly string[]> =>
  part === 'noun'
    ? tables.noun
    : part === 'verb'
      ? tables.verb
      : part === 'adjective'
        ? tables.adjective
        : tables.adverb;

/**
 * Every base form worth trying for a word, most likely first.
 *
 * Each candidate carries the rule that produced it, so a caller can apply a
 * stricter test than "this spelling exists" when it needs one.
 */
export const baseFormCandidates = (
  word: string,
  tables: MorphologyTables,
): readonly BaseFormCandidate[] => {
  const candidates: BaseFormCandidate[] = [];
  const seen = new Set<string>([word]);

  const add = (candidate: BaseFormCandidate): void => {
    if (candidate.base.length >= MINIMUM_BASE_LENGTH && !seen.has(candidate.base)) {
      seen.add(candidate.base);
      candidates.push(candidate);
    }
  };

  // 1. Possessives.
  if (POSSESSIVE.test(word)) {
    const stem = word.replace(POSSESSIVE, '');

    add({ base: stem, partOfSpeech: 'noun', origin: 'possessive', suffix: '' });

    // A plural possessive ("dogs'") still has to lose its plural.
    for (const nested of baseFormCandidates(stem, tables)) {
      add({ ...nested, origin: 'possessive' });
    }
  }

  // 2. The exception lists are authoritative where they apply.
  for (const part of PART_ORDER) {
    for (const base of tableFor(tables, part).get(word) ?? []) {
      add({ base, partOfSpeech: part, origin: 'exception', suffix: '' });
    }
  }

  // 3. Suffix detachment, in WordNet's order.
  for (const part of PART_ORDER) {
    for (const [suffix, replacement] of DETACHMENT_RULES[part]) {
      if (word.endsWith(suffix) && word.length > suffix.length + 1) {
        add({
          base: word.slice(0, word.length - suffix.length) + replacement,
          partOfSpeech: part,
          origin: 'detachment',
          suffix,
        });
      }
    }
  }

  // 4. Doubled final consonant.
  const doubled = DOUBLED_CONSONANT.exec(word);

  if (doubled !== null) {
    add({
      base: `${doubled[1] ?? ''}${doubled[2] ?? ''}`,
      partOfSpeech: 'verb',
      origin: 'doubled-consonant',
      suffix: doubled[3] ?? '',
    });
  }

  return candidates;
};

/** The base spellings alone, in the same order. */
export const baseForms = (word: string, tables: MorphologyTables): readonly string[] =>
  baseFormCandidates(word, tables).map((candidate) => candidate.base);

/**
 * Builds exception tables from plain objects.
 *
 * Used by the artifact loader. Anything that is not an array of non-empty
 * strings is dropped rather than repaired: a malformed table must weaken the
 * fallback, never corrupt it.
 */
export const morphologyTablesFrom = (source: {
  readonly noun?: unknown;
  readonly verb?: unknown;
  readonly adjective?: unknown;
  readonly adverb?: unknown;
}): MorphologyTables => {
  const table = (value: unknown): ReadonlyMap<string, readonly string[]> => {
    const map = new Map<string, readonly string[]>();

    if (typeof value !== 'object' || value === null) {
      return map;
    }

    for (const [inflected, bases] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(bases)) {
        continue;
      }

      const valid = bases.filter(
        (base): base is string => typeof base === 'string' && base.length > 0,
      );

      if (inflected.length > 0 && valid.length > 0) {
        map.set(inflected, valid);
      }
    }

    return map;
  };

  return {
    noun: table(source.noun),
    verb: table(source.verb),
    adjective: table(source.adjective),
    adverb: table(source.adverb),
  };
};
