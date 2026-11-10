/**
 * Pronunciations from the WN-LMF release.
 *
 * The WNDB files carry no pronunciation; the LMF XML distribution of the
 * same release does, for about one entry in five. They are copied exactly as
 * published, with the variety (`US`, `GB`) preserved, and never synthesised
 * or guessed — an entry without one simply has none.
 *
 * The file is 100 MB, so it is read line by line rather than parsed into a
 * document. The release is machine-generated with one element per line,
 * which is what makes that safe; anything unexpected is ignored rather than
 * guessed at.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const LEMMA = /<Lemma\s+writtenForm="([^"]*)"/u;
const PRONUNCIATION = /<Pronunciation(?:\s+variety="([^"]*)")?[^>]*>([^<]*)<\/Pronunciation>/u;

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

const decodeEntities = (value) =>
  value.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => ENTITIES[entity] ?? entity);

/**
 * Reads the pronunciation table.
 *
 * @param {string} path the decompressed LMF XML file
 * @returns {Promise<{ table: Map<string, { v?: string, i: string }[]>, count: number }>}
 *   lowercase written form → pronunciations, in file order
 */
export const readPronunciations = async (path) => {
  const table = new Map();
  let current = null;
  let count = 0;

  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const lemma = LEMMA.exec(line);

    if (lemma !== null) {
      current = decodeEntities(lemma[1]).toLowerCase();
      continue;
    }

    const pronunciation = PRONUNCIATION.exec(line);

    if (pronunciation === null || current === null) {
      continue;
    }

    const value = decodeEntities(pronunciation[2]).trim();

    if (value.length === 0) {
      continue;
    }

    const variety = pronunciation[1];
    const existing = table.get(current) ?? [];

    // The same written form appears once per part of speech; identical
    // pronunciations are kept once so the artifact does not grow with
    // duplicates.
    if (existing.some((entry) => entry.i === value && entry.v === variety)) {
      continue;
    }

    const record = variety === undefined ? { i: value } : { v: variety, i: value };

    existing.push(record);
    table.set(current, existing);
    count += 1;
  }

  return { table, count };
};
