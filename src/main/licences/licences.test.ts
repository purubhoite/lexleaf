import { describe, expect, it } from 'vitest';

import {
  APPLICATION_LICENCE_FILE,
  APPLICATION_NOTICE_FILE,
  applicationDocumentCandidates,
  dictionaryNoticePath,
  readLicenceDocument,
  readLicenceDocumentSafely,
  type LicenceSources,
} from './licences';

const packaged: LicenceSources = {
  appPath: '/app/resources/app.asar',
  resourcesPath: '/app/resources',
  packaged: true,
  dictionaryDirectory: '/app/resources/dictionary',
};

const development: LicenceSources = {
  appPath: '/project',
  resourcesPath: null,
  packaged: false,
  dictionaryDirectory: '/project/resources/dictionary',
};

/** A reader over a fixed set of files. Anything else does not exist. */
const reader =
  (files: Readonly<Record<string, string>>) =>
  (path: string): string | null =>
    files[path] ?? null;

const licence = 'APACHE LICENSE\nVersion 2.0\n';
const notice = 'Lexleaf\n\nCopyright ownership and licensing …\n';

describe('applicationDocumentCandidates', () => {
  it('prefers the unpacked copy, then the archive, then the application directory', () => {
    expect(applicationDocumentCandidates(packaged)).toEqual([
      '/app/resources/app.asar.unpacked',
      '/app/resources/app.asar',
    ]);
  });

  it('reads the project root during development, and nothing above it', () => {
    expect(applicationDocumentCandidates(development)).toEqual(['/project']);
  });

  it('ignores a resources path it was not told about when unpackaged', () => {
    const candidates = applicationDocumentCandidates({
      ...development,
      resourcesPath: '/elsewhere',
    });

    expect(candidates).toEqual(['/project']);
  });
});

describe('dictionaryNoticePath', () => {
  it('joins the artifact directory and the notice file name', () => {
    expect(dictionaryNoticePath(packaged)).toBe('/app/resources/dictionary/NOTICE.md');
  });

  it('is null when the dictionary is not installed', () => {
    expect(dictionaryNoticePath({ ...packaged, dictionaryDirectory: null })).toBeNull();
  });
});

describe('readLicenceDocument', () => {
  it('reads the licence and the notice as one document', () => {
    const result = readLicenceDocument('application', development, {
      readText: reader({ '/project/LICENSE': licence, '/project/NOTICE': notice }),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: 'application',
        title: 'Lexleaf — Apache License 2.0 and notices',
        // One blank line between them, and no trailing whitespace carried over.
        text: `${licence.trimEnd()}\n\n${notice.trimEnd()}`,
      },
    });
  });

  it('reads them from inside the asar archive when that is where they are', () => {
    const result = readLicenceDocument('application', packaged, {
      readText: reader({
        '/app/resources/app.asar/LICENSE': licence,
        '/app/resources/app.asar/NOTICE': notice,
      }),
    });

    expect(result.ok).toBe(true);
  });

  it('reports a build that shipped only one of the two files as not installed', () => {
    const result = readLicenceDocument('application', development, {
      readText: reader({ '/project/LICENSE': licence }),
    });

    expect(result).toEqual({ ok: false, reason: 'not-installed' });
  });

  it('reads the dictionary notice from the artifact directory', () => {
    const result = readLicenceDocument('dictionary', packaged, {
      readText: reader({ '/app/resources/dictionary/NOTICE.md': 'Open English WordNet 2024' }),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: 'dictionary',
        title: 'Dictionary data — third-party notices',
        text: 'Open English WordNet 2024',
      },
    });
  });

  it('reports a missing dictionary as not installed without reading the disk', () => {
    /** Fails the test if it is called at all. */
    const never = (): null => {
      throw new Error('readText must not be called when there is no artifact');
    };

    expect(
      readLicenceDocument(
        'dictionary',
        { ...packaged, dictionaryDirectory: null },
        {
          readText: never,
        },
      ),
    ).toEqual({ ok: false, reason: 'not-installed' });
  });

  it('names the files it expects, so the packaging can include them', () => {
    expect([APPLICATION_LICENCE_FILE, APPLICATION_NOTICE_FILE]).toEqual(['LICENSE', 'NOTICE']);
  });
});

describe('readLicenceDocumentSafely', () => {
  it('turns a reader that throws into unreadable rather than an exception', () => {
    const result = readLicenceDocumentSafely('application', development, {
      readText: () => {
        throw new Error('EACCES: permission denied, open /project/LICENSE');
      },
    });

    // Nothing from the error reaches the caller: no message, no path.
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });
});
