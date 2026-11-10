import { lookupCandidates, type LookupCandidate } from './candidates';
import { closedClassEntry } from './closedClass';
import { baseFormCandidates, type BaseFormCandidate, type MorphologyPart } from './morphology';
import { selectSenses } from './senseSelection';
import type {
  DictionaryAbsentField,
  DictionaryAttribution,
  DictionaryQuery,
  DictionaryResult,
  DictionarySense,
  DictionaryStore,
  MorphologyTables,
  StoredEntry,
  StoredSense,
} from './types';

/**
 * The lookup pipeline.
 *
 * One ordered pass over the candidate keys: exact, case, typographic,
 * morphology. The first key that produces at least one sense wins; if none
 * does, the answer is a miss. Nothing here is probabilistic, nothing is
 * ranked, nothing calls out of the process, and no answer is ever
 * manufactured — a field the source does not have is reported absent.
 */

/** Longest word a shadowing disclosure is computed for. */
const MINIMUM_SHADOWING_LENGTH = 6;

/** At most two "also an inflected form of" disclosures. */
const MAXIMUM_SHADOWING = 2;

export interface LookupContext {
  readonly store: DictionaryStore;
  readonly tables: MorphologyTables;
  readonly attribution: DictionaryAttribution;
}

const toSense = (sense: StoredSense): DictionarySense => ({
  partOfSpeech: sense.partOfSpeech,
  definition: sense.definition,
  examples: sense.examples,
  synonyms: sense.synonyms,
  source: 'wordnet',
});

/**
 * Whether a base form is a defensible inflection of an existing entry.
 *
 * Existence alone is not enough: "has" detaches to "ha" and "morning" to
 * "morn", and neither is an inflection. The rule that proposed the base form
 * also assumed a part of speech, so the entry has to actually have a sense
 * of that part of speech, and detached suffixes are only trusted on words
 * long enough for the suffix to be meaningful.
 */
const isDefensibleInflection = (
  word: string,
  candidate: BaseFormCandidate,
  entry: StoredEntry,
): boolean => {
  if (candidate.origin === 'possessive') {
    return false;
  }

  if (candidate.origin === 'detachment' && word.length < MINIMUM_SHADOWING_LENGTH) {
    return false;
  }

  const wanted =
    candidate.partOfSpeech === 'verb' || candidate.suffix === 'ing' || candidate.suffix === 'ed'
      ? ['verb']
      : [candidate.partOfSpeech];

  return entry.senses.some((sense) => wanted.includes(sense.partOfSpeech));
};

/**
 * Headwords the exact match is also an inflected form of.
 *
 * "running" has an entry of its own *and* is a form of "run". The exact
 * entry stays primary; this adds the subordinate disclosure.
 */
const shadowedHeadwords = (
  word: string,
  context: LookupContext,
  exclude: ReadonlySet<string>,
): readonly string[] => {
  const found: string[] = [];

  for (const candidate of baseFormCandidates(word, context.tables)) {
    if (found.length >= MAXIMUM_SHADOWING || exclude.has(candidate.base)) {
      continue;
    }

    const entry = context.store.get(candidate.base);

    if (entry !== null && isDefensibleInflection(word, candidate, entry)) {
      found.push(candidate.base);
    }
  }

  return found;
};

const absentFields = (
  senses: readonly DictionarySense[],
  pronunciationCount: number,
): readonly DictionaryAbsentField[] => {
  const absent: DictionaryAbsentField[] = [];

  if (pronunciationCount === 0) {
    absent.push('pronunciation');
  }

  if (!senses.some((sense) => sense.examples.length > 0)) {
    absent.push('examples');
  }

  if (!senses.some((sense) => sense.synonyms.length > 0)) {
    absent.push('synonyms');
  }

  return absent;
};

/**
 * Senses reordered so the part of speech the reader actually clicked comes
 * first.
 *
 * Only applies when the entry was reached by a morphological rule, because
 * only then is there an assumption to honour: the rule that turned
 * "watched" into "watch" is a verb rule, so the verb senses go first and
 * the pocket watch waits its turn. Nothing is dropped — the order changes,
 * the content does not — and when the entry has no sense of the assumed
 * part of speech the original order stands.
 */
const preferAssumedParts = (
  senses: readonly StoredSense[],
  assumed: readonly MorphologyPart[],
): readonly StoredSense[] => {
  if (assumed.length === 0) {
    return senses;
  }

  const wanted = senses.filter((sense) => assumed.includes(sense.partOfSpeech as MorphologyPart));

  if (wanted.length === 0 || wanted.length === senses.length) {
    return senses;
  }

  return [...wanted, ...senses.filter((sense) => !wanted.includes(sense))];
};

/** The spelling to show as the answering headword. */
const headwordOf = (key: string, senses: readonly StoredSense[]): string => {
  const first = senses[0];

  return first !== undefined && first.writtenForm.toLowerCase() === key ? first.writtenForm : key;
};

interface Match {
  readonly candidate: LookupCandidate;
  readonly senses: readonly DictionarySense[];
  readonly headword: string;
  readonly pronunciations: StoredEntry['pronunciations'];
  readonly fromWordNet: boolean;
}

/** Tries one key against both the dictionary data and the curated layer. */
const matchKey = (
  candidate: LookupCandidate,
  query: DictionaryQuery,
  context: LookupContext,
): Match | null => {
  const { key } = candidate;
  const curated = closedClassEntry(key);
  const entry = context.store.get(key);

  const selected =
    entry === null
      ? { senses: [], suppressed: 0 }
      : selectSenses(entry, query.raw, curated !== null);

  const stored =
    candidate.stage === 'morphology'
      ? { ...selected, senses: preferAssumedParts(selected.senses, candidate.assumedParts) }
      : selected;

  const curatedSenses: readonly DictionarySense[] =
    curated === null
      ? []
      : curated.senses.map((sense) => ({
          partOfSpeech: sense.partOfSpeech,
          definition: sense.definition,
          examples: sense.examples,
          synonyms: [],
          source: 'application' as const,
        }));

  const senses = [...curatedSenses, ...stored.senses.map(toSense)];

  if (senses.length === 0) {
    return null;
  }

  return {
    candidate,
    senses,
    headword: stored.senses.length > 0 ? headwordOf(key, stored.senses) : key,
    pronunciations: entry?.pronunciations ?? [],
    fromWordNet: stored.senses.length > 0,
  };
};

/**
 * Looks a word up.
 *
 * @param query the identified word, carrying both its normalised and raw form
 * @param context the store, the morphological tables and the attribution to
 *   stamp on an answer
 */
export const lookUpWord = (query: DictionaryQuery, context: LookupContext): DictionaryResult => {
  const display = query.raw.trim().length > 0 ? query.raw.trim() : query.normalized;
  const candidates = lookupCandidates(query, context.tables);

  for (const candidate of candidates) {
    const match = matchKey(candidate, query, context);

    if (match === null) {
      continue;
    }

    const resolvedBy =
      candidate.stage === 'exact' && !match.fromWordNet ? 'closed-class' : candidate.stage;

    const alsoInflectionOf =
      candidate.stage === 'exact'
        ? shadowedHeadwords(query.normalized, context, new Set([candidate.key]))
        : [];

    const absent = absentFields(match.senses, match.pronunciations.length);

    const answer = {
      queried: display,
      headword: match.headword,
      resolvedBy,
      senses: match.senses,
      pronunciations: match.pronunciations,
      alsoInflectionOf,
      attribution: context.attribution,
    };

    return absent.length === 0
      ? { status: 'found', ...answer }
      : { status: 'partial', ...answer, absentFields: absent };
  }

  return {
    status: 'not-found',
    queried: display,
    attempted: candidates.map((candidate) => candidate.key),
  };
};
