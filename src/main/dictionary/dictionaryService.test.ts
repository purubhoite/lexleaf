import { describe, expect, it, vi } from 'vitest';

import type { DictionaryQuery } from '@core/dictionary/types';
import { DictionaryArtifactError } from '@core/dictionary/wordnet/binaryIndex';
import type { DictionaryArtifact } from '@core/dictionary/wordnet/wordNetFileProvider';

import { DICTIONARY_FIXTURE_DIR } from '../../../tests/support/dictionaryFixture';

import { createDictionaryService } from './dictionaryService';
import { openFileArtifact } from './fileArtifact';

const query = (normalized: string): DictionaryQuery => ({
  normalized,
  raw: normalized,
  joinedAcrossLines: false,
});

const fixtureService = (
  overrides: Partial<Parameters<typeof createDictionaryService>[0]> = {},
): ReturnType<typeof createDictionaryService> =>
  createDictionaryService({
    locate: () => DICTIONARY_FIXTURE_DIR,
    open: openFileArtifact,
    ...overrides,
  });

describe('dictionary service', () => {
  it('opens the artifact once and reports what it opened', () => {
    const open = vi.fn(openFileArtifact);
    const service = fixtureService({ open });

    try {
      const status = service.prepare();

      expect(status.state).toBe('ready');
      expect(status.headwords).toBeGreaterThan(20);
      expect(status.release).toMatch(/Synthetic test dictionary/u);
      expect(status.openMilliseconds).toBeTypeOf('number');

      service.prepare();
      service.lookUp(query('book'));

      expect(open).toHaveBeenCalledOnce();
    } finally {
      service.close();
    }
  });

  it('is unopened until something asks it for a word', () => {
    const open = vi.fn(openFileArtifact);
    const service = fixtureService({ open });

    expect(service.status().state).toBe('unopened');
    expect(open).not.toHaveBeenCalled();

    service.lookUp(query('book'));

    expect(service.status().state).toBe('ready');
    service.close();
  });

  it('answers a query', () => {
    const service = fixtureService();

    try {
      expect(service.lookUp(query('book'))).toMatchObject({ status: 'found', headword: 'book' });
    } finally {
      service.close();
    }
  });

  it('reports an uninstalled dictionary without probing the filesystem twice', () => {
    const locate = vi.fn(() => null);
    const service = createDictionaryService({ locate, open: openFileArtifact });

    expect(service.lookUp(query('book'))).toEqual({
      status: 'unavailable',
      reason: 'not-installed',
    });
    expect(service.lookUp(query('run'))).toEqual({
      status: 'unavailable',
      reason: 'not-installed',
    });
    expect(locate).toHaveBeenCalledOnce();
  });

  it.each(['corrupt', 'unreadable', 'not-installed'] as const)(
    'turns a %s artifact into that unavailable reason',
    (reason) => {
      const service = createDictionaryService({
        locate: () => '/somewhere',
        open: () => {
          throw new DictionaryArtifactError(reason, 'the detail stays here');
        },
      });

      expect(service.lookUp(query('book'))).toEqual({ status: 'unavailable', reason });
    },
  );

  it('treats an unexpected failure as unreadable rather than crashing', () => {
    const service = createDictionaryService({
      locate: () => '/somewhere',
      open: () => {
        throw new TypeError('something nobody predicted');
      },
    });

    expect(service.lookUp(query('book'))).toEqual({ status: 'unavailable', reason: 'unreadable' });
  });

  it('keeps the failure detail in the main process', () => {
    const onDiagnostic = vi.fn();
    const service = createDictionaryService({
      locate: () => '/private/path/to/dictionary',
      open: () => {
        throw new DictionaryArtifactError('corrupt', 'ENOENT at /private/path/to/dictionary');
      },
      onDiagnostic,
    });

    const result = service.lookUp(query('book'));

    expect(JSON.stringify(result)).not.toMatch(/private|ENOENT/u);
    expect(onDiagnostic.mock.calls.join(' ')).toMatch(/private/u);
  });

  it('answers unavailable after it has been closed', () => {
    const service = fixtureService();

    service.prepare();
    service.close();

    expect(service.lookUp(query('book')).status).toBe('unavailable');
  });

  it('closes without having opened anything', () => {
    expect(() => {
      const service = createDictionaryService({
        locate: () => DICTIONARY_FIXTURE_DIR,
        open: openFileArtifact,
      });

      service.close();
    }).not.toThrow();
  });

  it('measures how long opening took', () => {
    let clock = 1_000;
    const service = fixtureService({
      now: () => {
        clock += 7;

        return clock;
      },
    });

    try {
      expect(service.prepare().openMilliseconds).toBe(7);
    } finally {
      service.close();
    }
  });

  it('needs nothing from an artifact beyond bytes it can read', () => {
    // Stated as a compiling value rather than as prose: an artifact is an
    // index, a payload it can read ranges from, two documents of metadata
    // and a way to let go. Nothing here can name a path or a network.
    const artifact: DictionaryArtifact = {
      index: new Uint8Array(),
      payload: { size: 0, read: () => new Uint8Array() },
      manifestText: '{}',
      morphologyText: '{}',
      close: () => undefined,
    };

    expect(Object.keys(artifact).sort()).toEqual([
      'close',
      'index',
      'manifestText',
      'morphologyText',
      'payload',
    ]);
  });
});
