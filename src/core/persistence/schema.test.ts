import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from './preferences';
import { CURRENT_SCHEMA_VERSION, emptyReaderState, rememberOpen } from './readerState';
import { parseReaderState, serializeReaderState } from './schema';
import { DEFAULT_ZOOM } from './types';

const sample = rememberOpen(emptyReaderState(), {
  id: 'id-a',
  path: '/books/a.pdf',
  name: 'a.pdf',
  sizeBytes: 2_048,
  pageCount: 12,
  at: '2026-03-04T05:06:07.000Z',
});

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'id-a',
  path: '/books/a.pdf',
  name: 'a.pdf',
  sizeBytes: 2_048,
  pageCount: 12,
  position: { page: 3, pageOffsetFraction: 0.5, zoom: { mode: 'fixed', scale: 1.25 } },
  lastOpenedAt: '2026-03-04T05:06:07.000Z',
  ...overrides,
});

const stored = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 1, documents: [record()], ...overrides });

describe('reader state schema', () => {
  it('round-trips a state through serialization', () => {
    const parsed = parseReaderState(serializeReaderState(sample));

    expect(parsed.recoveredFrom).toBeNull();
    expect(parsed.droppedRecords).toBe(0);
    expect(parsed.state).toEqual(sample);
  });

  it('writes the current schema version even if the value in memory is older', () => {
    const serialized = serializeReaderState({ ...sample, schemaVersion: 0 });

    expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION });
  });

  it('reports truncated or hand-edited JSON instead of throwing', () => {
    const parsed = parseReaderState('{"schemaVersion": 1, "documents": [');

    expect(parsed.recoveredFrom).toBe('unreadable-json');
    expect(parsed.state).toEqual(emptyReaderState());
  });

  it('rejects a document that is not an object', () => {
    expect(parseReaderState('[]').recoveredFrom).toBe('not-an-object');
    expect(parseReaderState('42').recoveredFrom).toBe('not-an-object');
    expect(parseReaderState('null').recoveredFrom).toBe('not-an-object');
  });

  it('rejects a missing or nonsensical schema version', () => {
    expect(parseReaderState('{"documents": []}').recoveredFrom).toBe('unknown-schema-version');
    expect(parseReaderState(stored({ schemaVersion: 0 })).recoveredFrom).toBe(
      'unknown-schema-version',
    );
  });

  it('refuses to interpret state written by a newer build', () => {
    const parsed = parseReaderState(stored({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }));

    expect(parsed.recoveredFrom).toBe('future-schema-version');
    expect(parsed.state.documents).toEqual([]);
  });

  it('drops individual records that could never be reopened, keeping the rest', () => {
    const parsed = parseReaderState(
      stored({
        documents: [
          record(),
          { path: '/books/b.pdf', name: 'b.pdf', lastOpenedAt: 'now' },
          'not a record',
          record({ id: 'id-c', name: 'c.pdf' }),
        ],
      }),
    );

    expect(parsed.recoveredFrom).toBeNull();
    expect(parsed.droppedRecords).toBe(2);
    expect(parsed.state.documents.map((document) => document.id)).toEqual(['id-a', 'id-c']);
  });

  it('repairs a position whose fields are out of range', () => {
    const parsed = parseReaderState(
      stored({
        documents: [
          record({ position: { page: -4, pageOffsetFraction: 9, zoom: { mode: 'huge' } } }),
        ],
      }),
    );

    expect(parsed.state.documents[0]?.position).toEqual({
      page: 1,
      pageOffsetFraction: 1,
      zoom: DEFAULT_ZOOM,
    });
  });

  it('replaces a missing position with the start of the document', () => {
    const parsed = parseReaderState(stored({ documents: [record({ position: undefined })] }));

    expect(parsed.state.documents[0]?.position).toEqual({
      page: 1,
      pageOffsetFraction: 0,
      zoom: DEFAULT_ZOOM,
    });
  });

  it('treats an unknown page count as unknown rather than zero', () => {
    const parsed = parseReaderState(stored({ documents: [record({ pageCount: 0 })] }));

    expect(parsed.state.documents[0]?.pageCount).toBeNull();
  });

  it('accepts a state file with no documents at all', () => {
    const parsed = parseReaderState('{"schemaVersion": 1}');

    expect(parsed.recoveredFrom).toBeNull();
    expect(parsed.state).toEqual(emptyReaderState());
  });
  /* ---------------------------------------------------------------- *
   * Preferences: schema v2 (ADR-031, 6.8)
   * ---------------------------------------------------------------- */

  it('gives a version-1 document the default preferences and nothing else', () => {
    const parsed = parseReaderState(stored());

    expect(parsed.recoveredFrom).toBeNull();
    expect(parsed.droppedRecords).toBe(0);
    expect(parsed.state.schemaVersion).toBe(2);
    expect(parsed.state.preferences).toStrictEqual(DEFAULT_PREFERENCES);
    // The migration is additive: the record that went in is the record
    // that comes out, with the same position and the same identity.
    expect(parsed.state.documents).toHaveLength(1);
    expect(parsed.state.documents[0]?.id).toBe('id-a');
    expect(parsed.state.documents[0]?.position).toEqual({
      page: 3,
      pageOffsetFraction: 0.5,
      zoom: { mode: 'fixed', scale: 1.25 },
    });
  });

  it('does not adopt a preference block from a document that says version 1', () => {
    // The version is the file's own statement about its shape. Reading a
    // field it does not promise is how a half-written document becomes
    // indistinguishable from a migrated one.
    const parsed = parseReaderState(
      stored({ preferences: { appearance: 'dark', showDeveloperDiagnostics: 'on' } }),
    );

    expect(parsed.state.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('reads a stored preference block at version 2', () => {
    const parsed = parseReaderState(
      stored({
        schemaVersion: 2,
        preferences: {
          appearance: 'dark',
          reduceMotion: 'always',
          defaultZoomMode: 'last-used',
          showDeveloperDiagnostics: 'on',
          pageTint: 'original',
        },
      }),
    );

    expect(parsed.recoveredFrom).toBeNull();
    expect(parsed.state.preferences).toStrictEqual({
      appearance: 'dark',
      reduceMotion: 'always',
      defaultZoomMode: 'last-used',
      showDeveloperDiagnostics: 'on',
      pageTint: 'original',
    });
  });

  it('normalises an unknown preference value instead of quarantining the file', () => {
    const parsed = parseReaderState(
      stored({
        schemaVersion: 2,
        preferences: { appearance: 'solarized', reduceMotion: 'never', defaultZoomMode: 7 },
      }),
    );

    expect(parsed.recoveredFrom).toBeNull();
    expect(parsed.state.preferences).toStrictEqual(DEFAULT_PREFERENCES);
    expect(parsed.state.documents).toHaveLength(1);
  });

  it('keeps the documents when the preference block is hostile rubbish', () => {
    for (const block of ['a string', 42, [], null, true, { appearance: { nested: true } }]) {
      const parsed = parseReaderState(stored({ schemaVersion: 2, preferences: block }));

      expect(parsed.recoveredFrom).toBeNull();
      expect(parsed.state.preferences).toStrictEqual(DEFAULT_PREFERENCES);
      expect(parsed.state.documents).toHaveLength(1);
    }
  });

  it('still quarantines a version from the future, preferences and all', () => {
    const parsed = parseReaderState(
      stored({ schemaVersion: 3, preferences: { appearance: 'dark' } }),
    );

    expect(parsed.recoveredFrom).toBe('future-schema-version');
    expect(parsed.state).toEqual(emptyReaderState());
    expect(parsed.state.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips the preferences through serialization', () => {
    const state = {
      ...sample,
      preferences: {
        appearance: 'light',
        reduceMotion: 'always',
        defaultZoomMode: 'fit-page',
        showDeveloperDiagnostics: 'on',
        pageTint: 'original',
      },
    } as const;

    const parsed = parseReaderState(serializeReaderState(state));

    expect(parsed.state.preferences).toStrictEqual(state.preferences);
  });

  it('writes exactly the four preference keys, whatever is in memory', () => {
    const serialized = serializeReaderState({
      ...sample,
      preferences: {
        ...DEFAULT_PREFERENCES,
        appearance: 'bright-orange',
        apiKey: 'sk-should-never-be-written',
      },
    } as unknown as typeof sample);

    expect(serialized).not.toContain('sk-should-never-be-written');
    expect(serialized).not.toContain('bright-orange');
    const written = JSON.parse(serialized) as { preferences: Record<string, unknown> };

    expect(Object.keys(written.preferences)).toStrictEqual([
      'appearance',
      'reduceMotion',
      'defaultZoomMode',
      'showDeveloperDiagnostics',
      'pageTint',
    ]);
  });

  it('writes the preferences beside the documents, not inside a record', () => {
    const written = JSON.parse(serializeReaderState(sample)) as {
      documents: readonly Record<string, unknown>[];
    };

    expect(Object.keys(written)).toStrictEqual(['schemaVersion', 'documents', 'preferences']);
    expect(written.documents[0]).not.toHaveProperty('preferences');
  });
});
