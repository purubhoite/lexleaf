import type { SaveWordRequest, SavedWord, VocabularyRepository } from '@core/vocabulary/types';
import { describe, expect, it, vi } from 'vitest';

import { VocabularyOpenError } from './connection';
import { createVocabularyService } from './vocabularyService';

/** The service turns exceptions into values, and keeps the details inside. */

const item: SavedWord = {
  id: 'item-1',
  word: { raw: 'mice', display: 'mice', normalized: 'mice', joinedAcrossLines: false },
  headword: 'mouse',
  resolvedBy: 'morphology',
  lookupStatus: 'found',
  shortDefinition: 'small rodents',
  snapshot: null,
  source: null,
  occurrences: [],
  savedAt: '2026-01-01T00:00:00.000Z',
  occurrenceCount: 1,
};

const request = {} as SaveWordRequest;

const repository = (overrides: Partial<VocabularyRepository> = {}): VocabularyRepository => ({
  stateForWord: () => ({ state: 'not-saved' }),
  save: () => item,
  find: () => item,
  remove: (): void => {},
  restore: (): void => {},
  list: () => ({ items: [item], nextCursor: null, unreadable: 0 }),
  search: () => ({ matches: [], definitionMatches: [], truncated: false, unreadable: 0 }),
  occurrences: () => [],
  documents: () => [],
  close: (): void => {},
  ...overrides,
});

describe('opening the store', () => {
  it('does not touch it until something is asked of it', () => {
    const open = vi.fn(() => repository());
    const service = createVocabularyService({ open });

    expect(open).not.toHaveBeenCalled();

    service.list({ sort: 'newest', documentId: null, cursor: null, limit: 50 });

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens once and reuses what it opened', () => {
    const open = vi.fn(() => repository());
    const service = createVocabularyService({ open });

    service.documents();
    service.documents();
    service.documents();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure instead of retrying on every call', () => {
    const open = vi.fn(() => {
      throw new VocabularyOpenError('not-writable', '/home/someone/.config/app/vocabulary.db');
    });
    const service = createVocabularyService({ open });

    expect(service.documents()).toEqual({
      ok: false,
      error: { kind: 'unavailable', reason: 'not-writable' },
    });
    expect(service.save(request)).toEqual({
      ok: false,
      error: { kind: 'unavailable', reason: 'not-writable' },
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps the path and the driver message in the main-process log only', () => {
    const onDiagnostic = vi.fn();
    const service = createVocabularyService({
      open: () => {
        throw new VocabularyOpenError('corrupt', '/home/someone/.config/app/vocabulary.db');
      },
      onDiagnostic,
    });

    const result = service.list({ sort: 'newest', documentId: null, cursor: null, limit: 50 });

    expect(JSON.stringify(result)).not.toContain('/home/someone');
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('/home/someone'));
  });
});

describe('answering with values rather than exceptions', () => {
  it('returns what the store returned', () => {
    const service = createVocabularyService({ open: () => repository() });

    expect(service.save(request)).toEqual({ ok: true, value: item });
    expect(service.stateForWord('mice', 'doc-1', 3)).toEqual({
      ok: true,
      value: { state: 'not-saved' },
    });
  });

  it('reports a failed write as a failed write', () => {
    const onDiagnostic = vi.fn();
    const service = createVocabularyService({
      open: () =>
        repository({
          save: () => {
            throw new Error('constraint something unexpected');
          },
        }),
      onDiagnostic,
    });

    expect(service.save(request)).toEqual({ ok: false, error: { kind: 'write-failed' } });
    expect(onDiagnostic).toHaveBeenCalled();
  });

  it('reports a locked database as locked rather than as a generic failure', () => {
    const service = createVocabularyService({
      open: () =>
        repository({
          save: () => {
            throw Object.assign(new Error('database is locked'), { errcode: 5 });
          },
        }),
    });

    expect(service.save(request)).toEqual({
      ok: false,
      error: { kind: 'unavailable', reason: 'locked' },
    });
  });

  it('survives a store that was never opened being closed', () => {
    const close = vi.fn();
    const service = createVocabularyService({ open: () => repository({ close }) });

    service.close();

    expect(close).not.toHaveBeenCalled();
  });

  it('closes what it opened, once', () => {
    const close = vi.fn();
    const service = createVocabularyService({ open: () => repository({ close }) });

    service.documents();
    service.close();
    service.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('answers after closing instead of reopening', () => {
    const open = vi.fn(() => repository());
    const service = createVocabularyService({ open });

    service.documents();
    service.close();

    expect(service.documents().ok).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
