/**
 * Reader for the WordNet database (WNDB) files of the pinned release.
 *
 * Only what the product needs is read: the lemma index, the synsets those
 * lemmas point at, the gloss split into a definition and its examples, the
 * spelling each sense is written with, and the morphological exception
 * lists. Semantic relations, sense keys, verb frames and sense counts are
 * discarded — that reduction is declared in the manifest's modification
 * statement.
 *
 * The format is documented in wndb(5). Everything here is deterministic: the
 * files are read in a fixed order and nothing depends on the filesystem's
 * iteration order, the locale or the clock.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Part of speech code in the artifact, per WNDB file. */
const POS_FILES = [
  ['noun', 'n'],
  ['verb', 'v'],
  ['adj', 'a'],
  ['adv', 'r'],
];

/** `adj.exc` and friends, mapped onto the names the application uses. */
const EXCEPTION_FILES = [
  ['noun', 'noun'],
  ['verb', 'verb'],
  ['adjective', 'adj'],
  ['adverb', 'adv'],
];

/** WNDB prefixes its data files with the licence, one numbered line each. */
const LICENCE_LINE = /^ {2}\d+ ?/u;

const isLicenceLine = (line) => line.startsWith('  ');

/** Strips the adjective syntactic marker, e.g. `big(p)` → `big`. */
const cleanMember = (word) => word.replace(/\(.*\)$/u, '').replace(/_/gu, ' ');

/** Splits a WordNet gloss into its definition and its quoted examples. */
const splitGloss = (gloss) => {
  const examples = [];
  const quoted = /"([^"]*)"/gu;
  let match = quoted.exec(gloss);

  while (match !== null) {
    const text = match[1].trim();

    if (text.length > 0) {
      examples.push(text);
    }

    match = quoted.exec(gloss);
  }

  const firstQuote = gloss.indexOf('"');
  const head = firstQuote === -1 ? gloss : gloss.slice(0, firstQuote);

  return { definition: head.replace(/;\s*$/u, '').trim(), examples };
};

/**
 * The licence header the upstream release ships inside its data files.
 *
 * Shipped verbatim in the generated notice, so the application distributes
 * the licence text it was actually given rather than a copy typed from
 * somewhere else.
 */
export const readLicenceHeader = (dir) => {
  const text = readFileSync(join(dir, 'data.noun'), 'utf8');
  const lines = [];

  for (const line of text.split('\n')) {
    if (!isLicenceLine(line)) {
      break;
    }

    lines.push(line.replace(LICENCE_LINE, '').replace(/\s+$/u, ''));
  }

  if (lines.length === 0) {
    throw new Error('the data files carry no licence header');
  }

  return `${lines.join('\n')}\n`;
};

/** Parses one `data.<pos>` file into a map of byte offset → synset. */
const readData = (dir, file) => {
  const text = readFileSync(join(dir, `data.${file}`), 'utf8');
  const synsets = new Map();

  for (const line of text.split('\n')) {
    if (line.length === 0 || isLicenceLine(line)) {
      continue;
    }

    const bar = line.indexOf('|');
    const fields = (bar === -1 ? line : line.slice(0, bar)).trim().split(/\s+/u);
    const offset = fields[0];
    const wordCount = Number.parseInt(fields[3], 16);

    if (offset === undefined || !Number.isFinite(wordCount)) {
      continue;
    }

    const members = [];

    for (let index = 0; index < wordCount; index += 1) {
      const member = fields[4 + index * 2];

      if (member !== undefined) {
        members.push(cleanMember(member));
      }
    }

    const { definition, examples } = splitGloss(bar === -1 ? '' : line.slice(bar + 1).trim());

    synsets.set(offset, { members, definition, examples });
  }

  return synsets;
};

/** Parses one `index.<pos>` file into ordered lemma → synset offsets. */
const readIndex = (dir, file) => {
  const text = readFileSync(join(dir, `index.${file}`), 'utf8');
  const lemmas = [];

  for (const line of text.split('\n')) {
    if (line.length === 0 || isLicenceLine(line)) {
      continue;
    }

    const fields = line.trim().split(/\s+/u);
    const lemma = (fields[0] ?? '').replace(/_/gu, ' ');
    const synsetCount = Number.parseInt(fields[2] ?? '', 10);
    const pointerCount = Number.parseInt(fields[3] ?? '', 10);

    if (lemma.length === 0 || !Number.isFinite(synsetCount) || !Number.isFinite(pointerCount)) {
      continue;
    }

    lemmas.push({
      lemma,
      offsets: fields.slice(6 + pointerCount, 6 + pointerCount + synsetCount),
    });
  }

  return lemmas;
};

/** Reads one morphological exception list (`<pos>.exc`). */
const readExceptionFile = (dir, file) => {
  const text = readFileSync(join(dir, `${file}.exc`), 'utf8');
  const pairs = [];

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }

    const [inflected, ...bases] = line.trim().split(/\s+/u);

    if (inflected !== undefined && bases.length > 0) {
      pairs.push([inflected, bases]);
    }
  }

  // Sorted so the generated file does not depend on the order the upstream
  // list happens to be in.
  pairs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return pairs;
};

/** All four exception lists, as plain sorted objects. */
export const readExceptions = (dir) => {
  const exceptions = {};
  let count = 0;

  for (const [name, file] of EXCEPTION_FILES) {
    const pairs = readExceptionFile(dir, file);

    exceptions[name] = Object.fromEntries(pairs);
    count += pairs.length;
  }

  return { exceptions, count };
};

/**
 * Builds the headword → senses map the artifact is written from.
 *
 * @param {string} dir the extracted WNDB directory
 * @param {{ sensesPerHeadword: number, examplesPerSense: number, synonymsPerSense: number }} limits
 */
export const readEntries = (dir, limits) => {
  /** @type {Map<string, { senses: object[] }>} */
  const entries = new Map();
  let senseCount = 0;

  for (const [file, code] of POS_FILES) {
    const synsets = readData(dir, file);

    for (const { lemma, offsets } of readIndex(dir, file)) {
      const key = lemma.toLowerCase();
      const senses = [];

      for (const offset of offsets.slice(0, limits.sensesPerHeadword)) {
        const synset = synsets.get(offset);

        if (synset === undefined || synset.definition.length === 0) {
          continue;
        }

        // The spelling this sense is written with. "he" is indexed in
        // lowercase, but the helium sense is spelled "He", and that single
        // fact is what lets the application keep a chemical symbol from
        // answering a pronoun.
        const written = synset.members.find((member) => member.toLowerCase() === key) ?? lemma;

        const synonyms = synset.members
          .filter((member) => member.toLowerCase() !== key)
          .slice(0, limits.synonymsPerSense);

        const examples = synset.examples.slice(0, limits.examplesPerSense);

        // Field order is fixed so that two builds of the same input produce
        // byte-identical JSON.
        const sense = { p: code, d: synset.definition };

        if (examples.length > 0) {
          sense.x = examples;
        }

        if (synonyms.length > 0) {
          sense.y = synonyms;
        }

        if (written !== key) {
          sense.w = written;
        }

        senses.push(sense);
      }

      if (senses.length === 0) {
        continue;
      }

      const existing = entries.get(key);

      if (existing === undefined) {
        entries.set(key, { senses });
      } else {
        existing.senses.push(...senses);
      }

      senseCount += senses.length;
    }
  }

  return { entries, senseCount };
};
