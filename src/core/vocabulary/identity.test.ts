import { describe, expect, it } from 'vitest';

import type { DictionaryResult } from '../dictionary/types';
import { identifyWordAt } from '../word/identifyWord';
import { normalizeWord } from '../word/normalizeWord';
import type { IdentifiedWord } from '../word/types';

import { buildSaveRequest, identifyForSaving, shortDefinitionFrom } from './identity';
import type { OccurrenceLocation, SavedDocumentFacts } from './types';

/** Identity is the normalised surface form, never the dictionary headword. */

const word = (raw: string, overrides: Partial<IdentifiedWord> = {}): IdentifiedWord => ({
  raw,
  display: raw,
  normalized: normalizeWord(raw),
  joinedAcrossLines: false,
  start: 10,
  end: 10 + raw.length,
  ...overrides,
});

const attribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Transformed into an indexed lookup artifact.',
  credits: ['Princeton University', 'The Open English WordNet team'],
};

const found = (headword: string, definition = 'to move fast'): DictionaryResult => ({
  status: 'found',
  queried: headword,
  headword,
  resolvedBy: 'morphology',
  senses: [
    {
      partOfSpeech: 'verb',
      definition,
      examples: ['she ran home'],
      synonyms: ['sprint'],
      source: 'wordnet',
    },
  ],
  pronunciations: [{ value: 'ɹʌn', variety: 'GB' }],
  alsoInflectionOf: [],
  attribution,
});

const notFound: DictionaryResult = { status: 'not-found', queried: 'zzz', attempted: ['zzz'] };

const unavailable: DictionaryResult = { status: 'unavailable', reason: 'not-installed' };

const document: SavedDocumentFacts = {
  id: 'doc-1',
  name: 'Essays.pdf',
  path: '/books/Essays.pdf',
  pageCount: 300,
  sizeBytes: 1_024,
};

const location: OccurrenceLocation = {
  page: 12,
  charStart: 10,
  charEnd: 13,
  pageOffsetFraction: 0.5,
  context: 'she ran home',
  contextWordStart: 4,
};

describe('identity is the normalised surface form', () => {
  it('does not use the dictionary headword: ran and run stay different items', () => {
    const ran = identifyForSaving(word('ran'), found('run'));
    const run = identifyForSaving(word('run'), found('run'));

    expect(ran.ok && ran.form.normalized).toBe('ran');
    expect(run.ok && run.form.normalized).toBe('run');
  });

  it('folds case: Mice and mice are one item', () => {
    const upper = identifyForSaving(word('Mice'), found('mouse'));
    const lower = identifyForSaving(word('mice'), found('mouse'));

    expect(upper.ok && upper.form.normalized).toBe('mice');
    expect(lower.ok && lower.form.normalized).toBe('mice');
  });

  it("keeps a possessive distinct: dog's is not dog", () => {
    const possessive = identifyForSaving(word("dog's"), found('dog'));
    const plain = identifyForSaving(word('dog'), found('dog'));

    expect(possessive.ok && possessive.form.normalized).toBe("dog's");
    expect(plain.ok && plain.form.normalized).toBe('dog');
  });

  it('unifies the typographic apostrophe through the M2 normaliser', () => {
    const typographic = identifyForSaving(word('dog\u2019s'), found('dog'));

    expect(typographic.ok && typographic.form.normalized).toBe("dog's");
  });

  it('delegates to normalizeWord rather than normalising a second way', () => {
    for (const sample of ['Café', 'ﬁnish', 'NASA', '\u00ADhyphen', 'don\u2019t', '“quoted”']) {
      const identity = identifyForSaving(word(sample), found('x'));

      expect(identity.ok && identity.form.normalized).toBe(normalizeWord(sample));
    }
  });

  it('agrees with what Milestone 2 identified, including across a line break', () => {
    const segments = [
      { text: 'a recon-', endsLine: true },
      { text: 'sidered opinion', endsLine: true },
    ];
    const identified = identifyWordAt(segments, { segmentIndex: 0, charOffset: 3 });

    expect(identified).not.toBeNull();

    const identity = identifyForSaving(identified as IdentifiedWord, found('reconsider'));

    expect(identity.ok && identity.form.normalized).toBe(identified?.normalized);
    expect(identity.ok && identity.form.normalized).toBe('reconsidered');
  });

  it('recomputes the normalised form from raw instead of trusting the caller', () => {
    const forged = word('mice', { normalized: 'elephant' });
    const identity = identifyForSaving(forged, found('mouse'));

    expect(identity.ok && identity.form.normalized).toBe('mice');
  });

  it('keeps raw exactly as the page had it, including a line break', () => {
    const broken = word('recon-\nsidered', { display: 'recon-sidered', joinedAcrossLines: true });
    const identity = identifyForSaving(broken, found('reconsider'));

    expect(identity.ok && identity.form.raw).toBe('recon-\nsidered');
    expect(identity.ok && identity.form.display).toBe('recon-sidered');
    expect(identity.ok && identity.form.normalized).toBe('reconsidered');
    expect(identity.ok && identity.form.joinedAcrossLines).toBe(true);
  });

  it('is unchanged by the dictionary result status', () => {
    const answered = identifyForSaving(word('mice'), found('mouse'));
    const missing = identifyForSaving(word('mice'), notFound);

    expect(answered.ok && answered.form.normalized).toBe(missing.ok && missing.form.normalized);
    expect(missing.ok && missing.status).toBe('not-found');
  });

  it('refuses a word that normalises to nothing', () => {
    const identity = identifyForSaving(word('—'), found('x'));

    expect(identity).toEqual({ ok: false, reason: 'empty-word' });
  });

  it('refuses to save when the dictionary could not answer at all', () => {
    const identity = identifyForSaving(word('mice'), unavailable);

    expect(identity).toEqual({ ok: false, reason: 'no-answer' });
  });
});

describe('the short definition', () => {
  it('is the first sense of an answer', () => {
    expect(shortDefinitionFrom(found('run', 'to move fast'))).toBe('to move fast');
  });

  it('is absent when there was no entry', () => {
    expect(shortDefinitionFrom(notFound)).toBeNull();
  });
});

describe('building a save request', () => {
  it('carries the word, the dictionary facts and the snapshot', () => {
    const request = buildSaveRequest(word('ran'), found('run'), document, location, '1.0.0');

    expect(request).not.toBeNull();
    expect(request?.word.normalized).toBe('ran');
    expect(request?.headword).toBe('run');
    expect(request?.resolvedBy).toBe('morphology');
    expect(request?.lookupStatus).toBe('found');
    expect(request?.shortDefinition).toBe('to move fast');
    expect(request?.snapshot?.senses).toHaveLength(1);
    expect(request?.source?.transformVersion).toBe('1.0.0');
    expect(request?.occurrence).toEqual(location);
  });

  it('saves a word the dictionary had no entry for, without a snapshot', () => {
    const request = buildSaveRequest(word('xyzzy'), notFound, document, location, '1.0.0');

    expect(request?.lookupStatus).toBe('not-found');
    expect(request?.snapshot).toBeNull();
    expect(request?.source).toBeNull();
    expect(request?.headword).toBeNull();
  });

  it('produces nothing when there is no answer to preserve', () => {
    expect(buildSaveRequest(word('mice'), unavailable, document, location, '1.0.0')).toBeNull();
  });
});
