import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseDictionaryManifest } from '../../src/core/dictionary/manifest';
import { openWordNetProvider } from '../../src/core/dictionary/wordnet/wordNetFileProvider';
import { openFileArtifact } from '../../src/main/dictionary/fileArtifact';

/**
 * The real artifact, when it has been built.
 *
 * Everything else in the suite runs against the synthetic fixture, by
 * design: no test may need a 29 MB download. This file is the exception
 * that checks the actual shipped data — its size budget, its checksums, the
 * words a reader will really look up — and skips itself when the artifact
 * has not been built (`npm run dictionary:build`), which is the normal state
 * of a fresh clone and of CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const directory = join(root, 'resources/dictionary');

const built = existsSync(join(directory, 'manifest.json'));

/** Budgets from the milestone brief. */
const INSTALLED_LIMIT_BYTES = 40 * 1000 * 1000;

describe.skipIf(!built)('the built dictionary artifact', () => {
  const provider = openWordNetProvider(openFileArtifact(directory));
  const look = (word: string, raw = word): ReturnType<typeof provider.lookUp> =>
    provider.lookUp({ normalized: word, raw, joinedAcrossLines: false });

  it('carries a manifest whose checksums match the files on disk', () => {
    const manifest = parseDictionaryManifest(
      readFileSync(join(directory, 'manifest.json'), 'utf8'),
    );

    expect(manifest).not.toBeNull();

    for (const file of manifest?.files ?? []) {
      const bytes = readFileSync(join(directory, file.name));

      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
  });

  it('names the pinned release it was built from', () => {
    const manifest = parseDictionaryManifest(
      readFileSync(join(directory, 'manifest.json'), 'utf8'),
    );

    expect(manifest?.source.dataset).toBe('Open English WordNet');
    expect(manifest?.source.release).toBe('2024');
    expect(manifest?.source.archiveSha256).toHaveLength(64);
    expect(manifest?.modified).toBe(true);
  });

  it('fits inside the installed size budget', () => {
    const total = ['entries.jsonl', 'entries.idx', 'morphology.json', 'manifest.json', 'NOTICE.md']
      .map((name) => statSync(join(directory, name)).size)
      .reduce((sum, size) => sum + size, 0);

    expect(total).toBeLessThanOrEqual(INSTALLED_LIMIT_BYTES);
  });

  it('holds the whole language, not a sample', () => {
    expect(provider.headwordCount).toBeGreaterThan(100_000);
  });

  it.each([
    ['lighthouse', 'lighthouse'],
    ['ran', 'run'],
    ['mice', 'mouse'],
    ['geese', 'goose'],
    ['children', 'child'],
    ['happiest', 'happy'],
    ['carried', 'carry'],
    ["dog's", 'dog'],
    ["don't", 'do'],
    // The 2024 release spells this one without a hyphen, so the hyphen
    // fallback is what answers it. Recorded as observed, not as hoped.
    ['co-operate', 'cooperate'],
  ])('answers %s with the entry for %s', (word, headword) => {
    expect(look(word)).toMatchObject({ headword });
  });

  it.each([
    ['he', 'pronoun'],
    ['at', 'preposition'],
    ['a', 'determiner'],
    ['the', 'determiner'],
    ['of', 'preposition'],
    ['and', 'conjunction'],
  ])('answers the common word %s as a %s', (word, part) => {
    const result = look(word);

    // Closed-class entries carry no example, synonym or pronunciation, so
    // the honest status for them is `partial`.
    expect(['found', 'partial']).toContain(result.status);
    expect(
      result.status === 'found' || result.status === 'partial' ? result.senses[0] : null,
    ).toMatchObject({ partOfSpeech: part, source: 'application' });
  });

  it('does not answer "he" with helium or "at" with astatine', () => {
    for (const word of ['he', 'at']) {
      const result = look(word);
      const text =
        result.status === 'found' || result.status === 'partial'
          ? result.senses.map((sense) => sense.definition).join(' ')
          : '';

      expect(text).not.toMatch(/helium|astatine|atomic number/iu);
    }
  });

  it('keeps the exact entry primary for an inflected spelling', () => {
    expect(look('running')).toMatchObject({ headword: 'running', alsoInflectionOf: ['run'] });
    expect(look('stopped')).toMatchObject({ headword: 'stopped', alsoInflectionOf: ['stop'] });
  });

  it.each(['watched', 'walked', 'carried'])(
    'answers the past-tense form %s with a verb sense first',
    (word) => {
      const result = look(word);
      const first =
        result.status === 'found' || result.status === 'partial' ? result.senses[0] : undefined;

      expect(first?.partOfSpeech).toBe('verb');
    },
  );

  it('reports a miss for something that is not a word', () => {
    expect(look('zzzznotaword')).toMatchObject({ status: 'not-found' });
  });

  it('carries pronunciation from the release where there is one, and invents none', () => {
    const withPronunciation = ['water', 'lighthouse', 'book', 'tomato']
      .map((word) => look(word))
      .filter((result) => result.status === 'found' || result.status === 'partial');

    expect(withPronunciation.length).toBeGreaterThan(0);

    for (const result of withPronunciation) {
      if (result.status !== 'found' && result.status !== 'partial') {
        continue;
      }

      for (const pronunciation of result.pronunciations) {
        expect(pronunciation.value).not.toBe('');
        expect(['US', 'GB', 'unspecified']).toContain(pronunciation.variety);
      }

      // A missing pronunciation is declared, never filled in.
      if (result.status === 'partial' && result.pronunciations.length === 0) {
        expect(result.absentFields).toContain('pronunciation');
      }
    }
  });

  it('answers quickly enough to feel instantaneous', () => {
    const words = ['lighthouse', 'ran', 'he', 'running', 'zzzznotaword', 'water', 'book'];
    const started = performance.now();

    for (let round = 0; round < 1_000; round += 1) {
      for (const word of words) {
        provider.lookUp({ normalized: word, raw: word, joinedAcrossLines: false });
      }
    }

    const perLookup = (performance.now() - started) / (1_000 * words.length);

    expect(perLookup).toBeLessThan(1);
  });

  it('ships a notice that carries both licences and claims no legal review', () => {
    const notice = readFileSync(join(directory, 'NOTICE.md'), 'utf8');

    expect(notice).toMatch(/Princeton University/u);
    expect(notice).toMatch(/Creative Commons Attribution 4\.0/u);
    expect(notice).toMatch(/WordNet/u);
    expect(notice).toMatch(/No legal review/iu);
    expect(notice).toMatch(/SHA-256/u);
  });
});
