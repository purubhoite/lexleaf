import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerVocabularyIpcHandlers } from '../../src/main/ipc/registerVocabularyIpcHandlers';
import type { IpcHandlerRegistrar, IpcInvokeListener } from '../../src/main/ipc/senderGuard';
import {
  VocabularyOpenError,
  classifyDatabaseError,
  openVocabularyDatabase,
} from '../../src/main/vocabulary/connection';
import { vocabularyDatabasePath } from '../../src/main/vocabulary/databaseFile';
import { migrateWithVerifiedBackups } from '../../src/main/vocabulary/destructiveMigrationCoordinator';
import { createExplanationStore } from '../../src/main/vocabulary/explanationStore';
import { createSqliteVocabularyRepository } from '../../src/main/vocabulary/sqliteVocabularyRepository';
import { createVocabularyBackupCoordinator } from '../../src/main/vocabulary/vocabularyBackupCoordinator';
import { createVocabularyDatabaseRuntime } from '../../src/main/vocabulary/vocabularyDatabaseRuntime';
import { createVocabularyMaintenanceGate } from '../../src/main/vocabulary/vocabularyMaintenanceGate';
import { inspectVocabularyRecovery } from '../../src/main/vocabulary/vocabularyRecovery';
import { createVocabularyService } from '../../src/main/vocabulary/vocabularyService';
import { IpcChannel } from '../../src/shared/ipc/channels';

/**
 * The vocabulary channels against the lazily prepared database, wired the
 * way `src/main/index.ts` wires them.
 *
 * The unit suite drives the handlers with a stub service, and the store
 * suite drives the service with an already-open database. Neither notices
 * a channel that reaches the service before the runtime has prepared the
 * connection — which is what shipped in v0.1.0: the popup's first question
 * ("is this word saved?") opened the store too early, the service
 * remembered that failure for the rest of the session, and every later
 * save and every visit to the library failed with it.
 */

const TRUSTED = { senderFrame: { url: 'file:///app/renderer/index.html' } };

const saveMessage = {
  word: { raw: 'Mice', display: 'Mice', normalized: 'mice', joinedAcrossLines: false },
  documentId: 'doc-1',
  pageCount: 300,
  occurrence: {
    page: 12,
    charStart: 10,
    charEnd: 14,
    pageOffsetFraction: 0.4,
    context: 'the mice scattered',
    contextWordStart: 4,
  },
  result: {
    status: 'found',
    queried: 'mice',
    headword: 'mouse',
    resolvedBy: 'morphology',
    senses: [
      {
        partOfSpeech: 'noun',
        definition: 'small rodents',
        examples: [],
        synonyms: [],
        source: 'wordnet',
      },
    ],
    pronunciations: [],
    alsoInflectionOf: [],
    attribution: {
      datasetName: 'Open English WordNet',
      release: '2024',
      licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
      modified: true,
      modificationStatement: 'Transformed.',
      credits: ['Princeton University'],
    },
  },
};

const stateMessage = { normalized: 'mice', documentId: 'doc-1', page: 12 };
const listMessage = { sort: 'newest', documentId: null, cursor: null };

interface Reply {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}

interface Launched {
  readonly call: (channel: string, payload: unknown) => Promise<Reply>;
  readonly quit: () => void;
}

/** One application launch: the same composition as the main process. */
const launch = async (userData: string): Promise<Launched> => {
  const backup = createVocabularyBackupCoordinator({
    userDataPath: userData,
    applicationVersion: '0.1.0',
  });
  const filePath = vocabularyDatabasePath(userData);
  const inspection = await inspectVocabularyRecovery(filePath, backup);
  const gate = createVocabularyMaintenanceGate();

  const runtime = createVocabularyDatabaseRuntime({
    open: () => {
      if (inspection.decision !== 'normal') {
        throw new VocabularyOpenError('recovery-required', 'recovery required');
      }

      return openVocabularyDatabase({ filePath, migrate: false }).database;
    },
    prepare: async (database): Promise<void> => {
      await migrateWithVerifiedBackups(database, { backup });
    },
    close: (database) => {
      database.close();
    },
    classifyFailure: classifyDatabaseError,
  });

  const prepared = (): NonNullable<ReturnType<typeof runtime.connection>> => {
    const database = runtime.connection();

    if (database === null) {
      throw new Error('vocabulary database was used before readiness');
    }

    return database;
  };

  const service = createVocabularyService({
    open: () => createSqliteVocabularyRepository({ database: prepared() }),
    openExplanations: () => createExplanationStore({ database: prepared() }),
  });

  const handlers = new Map<string, IpcInvokeListener>();
  const ipc: IpcHandlerRegistrar = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  };

  registerVocabularyIpcHandlers(ipc, {
    service,
    describeDocument: () =>
      Promise.resolve({
        id: 'doc-1',
        name: 'Essays.pdf',
        path: '/books/Essays.pdf',
        pageCount: 300,
        sizeBytes: 2_048,
      }),
    transformVersion: () => '1',
    onRejected: () => {},
    devServerOrigin: null,
    ensureReady: () => runtime.ensureReady(),
    enterOperation: gate.enter,
  });

  return {
    call: async (channel, payload) => {
      const listener = handlers.get(channel);

      if (listener === undefined) {
        throw new Error(`no handler for ${channel}`);
      }

      return (await listener(TRUSTED as never, payload)) as Reply;
    },
    quit: () => {
      service.close();
      runtime.close();
    },
  };
};

describe('vocabulary channels on a lazily prepared database', () => {
  const directories: string[] = [];

  const profile = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'lexleaf-ready-'));

    directories.push(directory);

    return directory;
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('answers the popup, saves the word and lists it on a first launch', async () => {
    const app = await launch(profile());

    // The order the reader produces: the popup asks, the reader saves,
    // the reader opens the library.
    const before = await app.call(IpcChannel.VocabularyStateForWord, stateMessage);
    const saved = await app.call(IpcChannel.VocabularySave, saveMessage);
    const listed = await app.call(IpcChannel.VocabularyList, listMessage);

    app.quit();

    expect(before).toEqual({ ok: true, value: { state: 'not-saved' } });
    expect(saved.ok).toBe(true);
    expect(listed.ok).toBe(true);
    expect((listed.value as { items: unknown[] }).items).toHaveLength(1);
  });

  it('saves when saving is the very first vocabulary request', async () => {
    const app = await launch(profile());
    const saved = await app.call(IpcChannel.VocabularySave, saveMessage);

    app.quit();

    expect(saved.ok).toBe(true);
  });

  it('finds the saved word and where it was met after a restart', async () => {
    const directory = profile();
    const first = await launch(directory);
    const saved = await first.call(IpcChannel.VocabularySave, saveMessage);

    first.quit();

    const second = await launch(directory);
    const state = await second.call(IpcChannel.VocabularyStateForWord, stateMessage);
    const occurrences = await second.call(IpcChannel.VocabularyOccurrences, {
      itemId: (saved.value as { id: string }).id,
    });

    second.quit();

    expect(state.ok).toBe(true);
    expect((state.value as { state: string }).state).not.toBe('not-saved');
    expect(occurrences.ok).toBe(true);
    expect(occurrences.value as unknown[]).toHaveLength(1);
  });
});
