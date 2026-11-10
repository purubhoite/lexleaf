import { describe, expect, it } from 'vitest';

import { attributionFrom, parseDictionaryManifest } from './manifest';

const valid = {
  formatVersion: 1,
  transformVersion: '1.0.0',
  source: {
    dataset: 'Open English WordNet',
    release: '2024',
    archiveUrl: 'https://example.invalid/wordnet.zip',
    archiveSha256: 'abc',
    pronunciationExcluded: false,
    pronunciationUrl: 'https://example.invalid/wordnet.xml.gz',
    pronunciationSha256: 'def',
  },
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Modified: filtered and reformatted.',
  credits: ['Open English WordNet team', 'Princeton University'],
  counts: { headwords: 10, senses: 20, bogus: 'no' },
  files: [{ name: 'entries.jsonl', bytes: 10, sha256: 'aaa' }],
};

const parse = (value: unknown): ReturnType<typeof parseDictionaryManifest> =>
  parseDictionaryManifest(JSON.stringify(value));

describe('dictionary manifest', () => {
  it('parses a complete manifest', () => {
    const manifest = parse(valid);

    expect(manifest).not.toBeNull();
    expect(manifest?.counts).toEqual({ headwords: 10, senses: 20 });
    expect(manifest?.files[0]?.sha256).toBe('aaa');
  });

  it('derives the attribution shown in the application', () => {
    const manifest = parse(valid);

    expect(manifest === null ? null : attributionFrom(manifest)).toEqual({
      datasetName: 'Open English WordNet',
      release: '2024',
      licences: valid.licences,
      modified: true,
      modificationStatement: 'Modified: filtered and reformatted.',
      credits: valid.credits,
    });
  });

  it('rejects text that is not JSON', () => {
    expect(parseDictionaryManifest('{')).toBeNull();
  });

  it('accepts an excluded pronunciation source without pronunciation metadata', () => {
    const malformedSource: Record<string, unknown> = {
      ...valid.source,
      pronunciationExcluded: true,
    };
    delete malformedSource['pronunciationUrl'];
    delete malformedSource['pronunciationSha256'];
    const candidate = {
      ...valid,
      source: malformedSource,
      counts: { headwords: 10, senses: 20, pronunciations: 0 },
    };
    expect(parse(candidate)).not.toBeNull();
  });

  it.each([
    ['an unknown format version', { ...valid, formatVersion: 2 }],
    ['missing pronunciation exclusion policy', { ...valid, source: { ...valid.source, pronunciationExcluded: undefined } }],
    ['excluded pronunciation with metadata', { ...valid, source: { ...valid.source, pronunciationExcluded: true } }],
    ['excluded pronunciation with a positive count', { ...valid, source: { ...valid.source, pronunciationExcluded: true }, counts: { pronunciations: 1 } }],
    ['included pronunciation without metadata', { ...valid, source: { ...valid.source, pronunciationExcluded: false, pronunciationUrl: undefined } }],
    ['a missing source', { ...valid, source: undefined }],
    ['a source without a checksum', { ...valid, source: { ...valid.source, archiveSha256: '' } }],
    ['no licences', { ...valid, licences: [] }],
    ['a licence without a url', { ...valid, licences: [{ name: 'CC BY 4.0' }] }],
    ['no credits', { ...valid, credits: [] }],
    ['no modification statement', { ...valid, modificationStatement: '' }],
    ['an unmodified claim', { ...valid, modified: false }],
    ['a file entry without a checksum', { ...valid, files: [{ name: 'a', bytes: 1 }] }],
  ])('rejects %s', (_name, candidate) => {
    expect(parse(candidate)).toBeNull();
  });
});
