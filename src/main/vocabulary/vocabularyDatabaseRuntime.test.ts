import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { createVocabularyDatabaseRuntime } from './vocabularyDatabaseRuntime';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const file = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vocab-runtime-'));
  dirs.push(d);
  return join(d, 'vocabulary.db');
};

describe('VocabularyDatabaseRuntime', () => {
  it('is lazy and prepares one real SQLite connection', async () => {
    const path = file();
    let opens = 0;
    let closes = 0;
    const runtime = createVocabularyDatabaseRuntime({
      open: () => {
        opens += 1;
        return new DatabaseSync(path);
      },
      prepare: (db) => db.exec('CREATE TABLE t (value TEXT)'),
      close: (db) => {
        closes += 1;
        db.close();
      },
    });
    expect(runtime.state()).toBe('unopened');
    expect(opens).toBe(0);
    const db = await runtime.ensureReady();
    expect(runtime.state()).toBe('ready');
    expect(opens).toBe(1);
    db.prepare('INSERT INTO t VALUES (?)').run('ready');
    expect((db.prepare('SELECT count(*) n FROM t').get() as { n: number }).n).toBe(1);
    runtime.close();
    expect(closes).toBe(1);
    expect(runtime.state()).toBe('closed');
  });

  it('shares concurrent preparation and opens exactly once', async () => {
    const path = file();
    let opens = 0;
    let preparations = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runtime = createVocabularyDatabaseRuntime({
      open: () => {
        opens += 1;
        return new DatabaseSync(path);
      },
      prepare: async (db) => {
        preparations += 1;
        await gate;
        db.exec('CREATE TABLE t (x)');
      },
      close: (db) => db.close(),
    });
    const a = runtime.ensureReady();
    const b = runtime.ensureReady();
    expect(a).toBe(b);
    expect(opens).toBe(1);
    expect(runtime.state()).toBe('preparing');
    release();
    expect(await a).toBe(await b);
    expect(preparations).toBe(1);
    runtime.close();
  });

  it('cleans up a failed preparation and retries safely', async () => {
    const path = file();
    let opens = 0;
    let closes = 0;
    let fail = true;
    const runtime = createVocabularyDatabaseRuntime({
      open: () => {
        opens += 1;
        return new DatabaseSync(path);
      },
      prepare: (db) => {
        if (fail) {
          fail = false;
          throw new Error('prepare failed');
        }
        db.exec('CREATE TABLE t (x)');
      },
      close: (db) => {
        closes += 1;
        db.close();
      },
    });
    await expect(runtime.ensureReady()).rejects.toThrow('prepare failed');
    expect(runtime.state()).toBe('failed');
    expect(runtime.connection()).toBeNull();
    expect(closes).toBe(1);
    await runtime.ensureReady();
    expect(runtime.state()).toBe('ready');
    expect(opens).toBe(2);
    runtime.close();
    expect(closes).toBe(2);
  });

  it('does not expose a partial connection and closes during pending preparation', async () => {
    const path = file();
    let closes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runtime = createVocabularyDatabaseRuntime({
      open: () => new DatabaseSync(path),
      prepare: async () => {
        await gate;
      },
      close: (db) => {
        closes += 1;
        db.close();
      },
    });
    const pending = runtime.ensureReady();
    expect(runtime.connection()).toBeNull();
    runtime.close();
    release();
    await expect(pending).rejects.toThrow();
    expect(runtime.connection()).toBeNull();
    expect(closes).toBe(1);
    await expect(runtime.ensureReady()).rejects.toThrow('closed');
  });

  it('does not double-close', async () => {
    const path = file();
    let closes = 0;
    const runtime = createVocabularyDatabaseRuntime({
      open: () => new DatabaseSync(path),
      prepare: () => {},
      close: (db) => {
        closes += 1;
        db.close();
      },
    });
    await runtime.ensureReady();
    runtime.close();
    runtime.close();
    expect(closes).toBe(1);
  });
});
