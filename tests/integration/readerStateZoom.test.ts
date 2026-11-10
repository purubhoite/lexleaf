import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  resolveDefaultZoom,
  type DefaultZoomMode,
} from '../../src/core/persistence/preferences';
import { DEFAULT_ZOOM, type ZoomState } from '../../src/core/persistence/types';
import { readDocumentFile } from '../../src/main/documents/documentFile';
import { registerDocumentIpcHandlers } from '../../src/main/ipc/registerDocumentIpcHandlers';
import { registerStateIpcHandlers } from '../../src/main/ipc/registerStateIpcHandlers';
import type { IpcHandlerRegistrar, IpcInvokeListener } from '../../src/main/ipc/senderGuard';
import { createReaderStateStore } from '../../src/main/persistence/readerStateStore';
import { createReaderStateService } from '../../src/main/state/readerStateService';
import { IpcChannel } from '../../src/shared/ipc/channels';
import {
  parseDocumentRequestResult,
  parseReaderStateSnapshot,
  type DocumentPayload,
  type DocumentRequestResult,
} from '../../src/shared/ipc/contracts';

/**
 * What `defaultZoomMode: 'last-used'` opens a document at, over the real
 * main-process path (ADR-031, and the defect the 6.8 closure audit found).
 *
 * Nothing here is a fixture of the answer. A real file-backed reader state
 * is written to a temporary directory, the real service reads it, the real
 * IPC handlers are invoked through the real sender guard, the result is
 * validated by the same parser the preload bridge uses, and only then is
 * the zoom resolved by the same function the renderer calls. The original
 * implementation passed its unit test by being handed a snapshot the
 * application never produced; this test can only pass if the application
 * really produces the value.
 */

interface FakeIpc extends IpcHandlerRegistrar {
  readonly handlers: Map<string, IpcInvokeListener>;
}

const createIpc = (): FakeIpc => {
  const handlers = new Map<string, IpcInvokeListener>();

  return {
    handlers,
    handle(channel, listener): void {
      handlers.set(channel, listener);
    },
  };
};

/** A sender the guard accepts: the application's own bundled frame. */
const TRUSTED_FRAME = { senderFrame: { url: 'file:///app/renderer/index.html' } };

const files = {
  readFile: async (path: string): Promise<string> => readFile(path, 'utf8'),
  writeFile: async (path: string, contents: string): Promise<void> =>
    writeFile(path, contents, 'utf8'),
  rename: async (from: string, to: string): Promise<void> => rename(from, to),
};

const documentFileSystem = {
  stat,
  readFile: async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path)),
};

let directory = '';
let statePath = '';
/** Every store opened by a test, so pending writes finish before cleanup. */
const sessions: (() => Promise<void>)[] = [];

/**
 * One run of the application over the state file on disk: the same objects
 * `src/main/index.ts` wires together, minus Electron itself.
 */
const launch = (
  initialDocumentPath: string | null,
  chosenDocumentPath: string | null = null,
): {
  readonly ipc: FakeIpc;
  readonly flush: () => Promise<void>;
} => {
  const store = createReaderStateStore({
    filePath: statePath,
    files,
    onWarning: () => undefined,
    writeDelayMs: 0,
  });

  const readerState = createReaderStateService({
    store,
    readDocument: async (path) => readDocumentFile(path, documentFileSystem),
    exists: () => Promise.resolve(true),
    now: () => new Date('2026-06-01T12:00:00.000Z'),
  });

  const ipc = createIpc();

  registerDocumentIpcHandlers(ipc, {
    chooseDocument: () =>
      chosenDocumentPath === null
        ? Promise.resolve<DocumentRequestResult>({ status: 'none' })
        : readerState.openPath(chosenDocumentPath),
    initialDocument: () =>
      initialDocumentPath === null
        ? Promise.resolve<DocumentRequestResult>({ status: 'none' })
        : readerState.openPath(initialDocumentPath),
    openRecentDocument: (documentId) => readerState.openRecent(documentId),
    devServerOrigin: null,
  });

  registerStateIpcHandlers(ipc, {
    snapshot: () => readerState.snapshot(),
    savePosition: (update) => readerState.savePosition(update),
    forgetDocument: (documentId) => readerState.forget(documentId),
    savePreferences: (preferences) => readerState.savePreferences(preferences),
    onRejected: () => undefined,
    devServerOrigin: null,
  });

  const flush = (): Promise<void> => store.flush();

  sessions.push(flush);

  return { ipc, flush };
};

/** The value side of `IpcChannel`, which is a frozen object rather than an enum. */
type Channel = (typeof IpcChannel)[keyof typeof IpcChannel];

/** Invokes a channel exactly as a trusted renderer frame would. */
const invoke = (ipc: FakeIpc, channel: Channel, ...args: unknown[]): Promise<unknown> => {
  const handler = ipc.handlers.get(channel);

  if (handler === undefined) {
    throw new Error(`${String(channel)} was never registered`);
  }

  return Promise.resolve(handler(TRUSTED_FRAME, ...args));
};

/** The opened payload as the preload bridge would hand it to the renderer. */
const openedThrough = async (
  ipc: FakeIpc,
  channel: Channel,
  ...args: unknown[]
): Promise<DocumentPayload> => {
  const parsed = parseDocumentRequestResult(await invoke(ipc, channel, ...args));

  if (parsed === null || parsed.status !== 'opened') {
    throw new Error(`${String(channel)} did not open a document: ${JSON.stringify(parsed)}`);
  }

  return parsed.document;
};

/** What the reader would actually open at, given the preference. */
const opensAt = (payload: DocumentPayload, mode: DefaultZoomMode = 'last-used'): ZoomState =>
  payload.position?.zoom ?? resolveDefaultZoom(mode, payload.lastUsedZoom ?? null);

const READ_AT: ZoomState = { mode: 'fixed', scale: 1.75 };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'reader-zoom-'));
  statePath = join(directory, 'reader-state.json');

  await writeFile(join(directory, 'a.pdf'), '%PDF-1.7 first document\n', 'utf8');
  await writeFile(join(directory, 'b.pdf'), '%PDF-1.7 second document\n', 'utf8');
  await writeFile(join(directory, 'c.pdf'), '%PDF-1.7 third document\n', 'utf8');
});

afterEach(async () => {
  // A store writes on a timer; letting those writes land first keeps the
  // cleanup from racing a rename into the directory it is removing.
  await Promise.all(sessions.map((flush) => flush()));
  sessions.length = 0;

  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

/** Reads document A and leaves it at 175 %, writing that to the state file. */
const seedDocumentReadAt175 = async (): Promise<void> => {
  const session = launch(join(directory, 'a.pdf'));
  const payload = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);

  await invoke(session.ipc, IpcChannel.SaveReadingPosition, {
    documentId: payload.id,
    position: { page: 3, pageOffsetFraction: 0.4, zoom: READ_AT },
    pageCount: 12,
  });
  await session.flush();

  const written = JSON.parse(await readFile(statePath, 'utf8')) as {
    documents: readonly { position: { zoom: ZoomState } }[];
  };

  expect(written.documents[0]?.position.zoom).toEqual(READ_AT);
};

describe('the zoom a document opens at over the real main-process path', () => {
  it('opens a new document at the previous document zoom on startup', async () => {
    await seedDocumentReadAt175();

    // A restart with a different document on the command line: the main
    // process records this open before the renderer can ask anything.
    const session = launch(join(directory, 'b.pdf'));
    const payload = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);

    expect(payload.name).toBe('b.pdf');
    expect(payload.position).toBeNull();
    expect(opensAt(payload)).toEqual(READ_AT);

    // The ordering that caused the defect is still the ordering in force:
    // by the time any snapshot can be fetched, the new document is already
    // the most recent one and carries the start-of-document zoom.
    const snapshot = parseReaderStateSnapshot(await invoke(session.ipc, IpcChannel.GetReaderState));

    expect(snapshot?.recents[0]?.id).toBe(payload.id);
    expect(snapshot?.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('opens a document chosen from inside the application at the zoom in use', async () => {
    await seedDocumentReadAt175();

    // One run: document A is reopened and restored at 175 %, and document
    // C is then chosen from the file dialog without restarting.
    const session = launch(join(directory, 'a.pdf'), join(directory, 'c.pdf'));
    const restored = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);

    expect(restored.position?.zoom).toEqual(READ_AT);

    const chosen = await openedThrough(session.ipc, IpcChannel.OpenDocumentDialog);

    expect(chosen.name).toBe('c.pdf');
    expect(chosen.position).toBeNull();
    expect(opensAt(chosen)).toEqual(READ_AT);
  });

  it('carries the zoom the reader changed to, not the one the document opened at', async () => {
    await seedDocumentReadAt175();

    const session = launch(join(directory, 'a.pdf'), join(directory, 'c.pdf'));
    const restored = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);

    // The reader zooms out to 125 % while reading, as the reader view does
    // on every zoom change.
    await invoke(session.ipc, IpcChannel.SaveReadingPosition, {
      documentId: restored.id,
      position: { page: 5, pageOffsetFraction: 0, zoom: { mode: 'fixed', scale: 1.25 } },
      pageCount: 12,
    });

    expect(opensAt(await openedThrough(session.ipc, IpcChannel.OpenDocumentDialog))).toEqual({
      mode: 'fixed',
      scale: 1.25,
    });
  });

  it('reopens a document from the recent list at its own remembered zoom', async () => {
    await seedDocumentReadAt175();

    const session = launch(join(directory, 'b.pdf'));
    const opened = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);
    const snapshot = parseReaderStateSnapshot(await invoke(session.ipc, IpcChannel.GetReaderState));
    const previous = snapshot?.recents.find((recent) => recent.id !== opened.id);

    const reopened = await openedThrough(
      session.ipc,
      IpcChannel.OpenRecentDocument,
      previous?.id ?? '',
    );

    expect(reopened.name).toBe('a.pdf');
    expect(opensAt(reopened)).toEqual(READ_AT);
    // …and it is the remembered position that did it, not the hint.
    expect(reopened.position?.page).toBe(3);
  });

  it('falls back to the default zoom when there is no previous document', async () => {
    const session = launch(join(directory, 'b.pdf'));
    const payload = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);

    expect(payload.lastUsedZoom).toBeNull();
    expect(opensAt(payload)).toEqual(DEFAULT_ZOOM);
  });

  it('falls back to the default zoom when the previous document was never zoomed', async () => {
    const first = launch(join(directory, 'a.pdf'));

    await openedThrough(first.ipc, IpcChannel.GetInitialDocument);
    await first.flush();

    const second = launch(join(directory, 'b.pdf'));

    expect(opensAt(await openedThrough(second.ipc, IpcChannel.GetInitialDocument))).toEqual(
      DEFAULT_ZOOM,
    );
  });

  it('keeps fit-width and fit-page answering for themselves', async () => {
    await seedDocumentReadAt175();

    const session = launch(join(directory, 'b.pdf'));
    const payload = await openedThrough(session.ipc, IpcChannel.GetInitialDocument);

    expect(opensAt(payload, 'fit-width')).toEqual({ mode: 'fit-width', scale: 1 });
    expect(opensAt(payload, 'fit-page')).toEqual({ mode: 'fit-page', scale: 1 });
  });

  it('still refuses an untrusted sender on the document channels', () => {
    const session = launch(join(directory, 'b.pdf'));
    const handler = session.ipc.handlers.get(IpcChannel.GetInitialDocument);

    expect(() => handler?.({ senderFrame: { url: 'https://example.com/' } })).toThrow(
      /untrusted sender/u,
    );
  });
});
