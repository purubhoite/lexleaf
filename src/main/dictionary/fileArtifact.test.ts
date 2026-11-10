import { cpSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DictionaryArtifactError } from '@core/dictionary/wordnet/binaryIndex';
import { openWordNetProvider } from '@core/dictionary/wordnet/wordNetFileProvider';

import { DICTIONARY_FIXTURE_DIR } from '../../../tests/support/dictionaryFixture';

import { INDEX_FILE, MANIFEST_FILE, openFileArtifact, PAYLOAD_FILE } from './fileArtifact';

/**
 * The adapter over a real directory of real files.
 *
 * It runs against the committed synthetic fixture — built by the same
 * writer as the shipped artifact — so the whole path from bytes on disk to a
 * `DictionaryResult` is exercised without downloading anything.
 */

const temporaries: string[] = [];

const copyOfFixture = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dictionary-artifact-'));

  temporaries.push(directory);
  cpSync(DICTIONARY_FIXTURE_DIR, directory, { recursive: true });

  return directory;
};

afterEach(() => {
  while (temporaries.length > 0) {
    rmSync(temporaries.pop() ?? '', { recursive: true, force: true });
  }
});

describe('file artifact', () => {
  it('opens the fixture and answers a lookup', () => {
    const provider = openWordNetProvider(openFileArtifact(DICTIONARY_FIXTURE_DIR));

    try {
      expect(provider.headwordCount).toBeGreaterThan(20);
      expect(provider.manifest.source.dataset).toBe('Synthetic test dictionary');
      expect(
        provider.lookUp({ normalized: 'book', raw: 'book', joinedAcrossLines: false }),
      ).toMatchObject({ status: 'found', headword: 'book', resolvedBy: 'exact' });
    } finally {
      provider.close();
    }
  });

  it('reads each entry from its own byte range', () => {
    const provider = openWordNetProvider(openFileArtifact(DICTIONARY_FIXTURE_DIR));

    try {
      for (const word of ['book', 'run', 'water', 'lighthouse', 'london']) {
        const result = provider.lookUp({ normalized: word, raw: word, joinedAcrossLines: false });

        expect(result.status).not.toBe('not-found');
        expect(
          result.status === 'found' || result.status === 'partial' ? result.headword : '',
        ).toMatch(new RegExp(word, 'iu'));
      }
    } finally {
      provider.close();
    }
  });

  it('serves repeated lookups from its cache without changing the answer', () => {
    const provider = openWordNetProvider(openFileArtifact(DICTIONARY_FIXTURE_DIR), {
      cacheSize: 2,
    });

    try {
      const query = { normalized: 'book', raw: 'book', joinedAcrossLines: false };
      const first = provider.lookUp(query);

      provider.lookUp({ normalized: 'run', raw: 'run', joinedAcrossLines: false });
      provider.lookUp({ normalized: 'water', raw: 'water', joinedAcrossLines: false });

      expect(provider.lookUp(query)).toEqual(first);
    } finally {
      provider.close();
    }
  });

  it('treats a malformed payload record as an absent entry', () => {
    const provider = openWordNetProvider(openFileArtifact(DICTIONARY_FIXTURE_DIR));

    try {
      // The fixture deliberately contains one record with an unknown part of
      // speech and an empty definition.
      expect(
        provider.lookUp({
          normalized: 'brokenentry',
          raw: 'brokenentry',
          joinedAcrossLines: false,
        }),
      ).toMatchObject({ status: 'not-found' });
    } finally {
      provider.close();
    }
  });

  it('reports a missing artifact as not installed', () => {
    try {
      openFileArtifact(join(tmpdir(), 'no-dictionary-here'));
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DictionaryArtifactError);
      expect((error as DictionaryArtifactError).reason).toBe('not-installed');
    }
  });

  it('reports a truncated index as corrupt', () => {
    const directory = copyOfFixture();

    truncateSync(join(directory, INDEX_FILE), 20);

    expect(() => openWordNetProvider(openFileArtifact(directory))).toThrow(
      expect.objectContaining({ reason: 'corrupt' }),
    );
  });

  it('reports an index whose records overrun the payload as corrupt', () => {
    const directory = copyOfFixture();
    const payload = join(directory, PAYLOAD_FILE);

    writeFileSync(payload, readFileSync(payload).subarray(0, 64));

    expect(() => openWordNetProvider(openFileArtifact(directory))).toThrow(
      expect.objectContaining({ reason: 'corrupt' }),
    );
  });

  it('reports a manifest that does not validate as corrupt', () => {
    const directory = copyOfFixture();

    writeFileSync(join(directory, MANIFEST_FILE), '{"formatVersion": 99}', 'utf8');

    expect(() => openWordNetProvider(openFileArtifact(directory))).toThrow(
      expect.objectContaining({ reason: 'corrupt' }),
    );
  });

  it('closes cleanly and refuses to answer afterwards', () => {
    const provider = openWordNetProvider(openFileArtifact(copyOfFixture()));

    provider.close();
    provider.close();

    expect(provider.lookUp({ normalized: 'book', raw: 'book', joinedAcrossLines: false })).toEqual({
      status: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('never leaks a path or an errno into a result', () => {
    const directory = copyOfFixture();

    truncateSync(join(directory, INDEX_FILE), 20);

    let reported: unknown = null;

    try {
      openWordNetProvider(openFileArtifact(directory));
    } catch (error: unknown) {
      reported = error;
    }

    expect(reported).toBeInstanceOf(DictionaryArtifactError);
    expect((reported as Error).message).not.toContain(directory);
  });
});
