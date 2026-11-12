import { mkdtemp, mkdir, rm, writeFile, chmod, truncate } from 'node:fs/promises';
import { readFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IpcChannel } from '@shared/ipc/channels';
import {
  DOCUMENT_FAILURE_REASONS,
  type DocumentFailureReason,
  type DocumentRequestResult,
} from '@shared/ipc/contracts';

import { MAX_DOCUMENT_BYTES, readDocumentFile } from '../../src/main/documents/documentFile';
import type { FileSystemAccess } from '../../src/main/documents/documentFile';
import { registerDocumentIpcHandlers } from '../../src/main/ipc/registerDocumentIpcHandlers';
import type { IpcHandlerRegistrar, IpcInvokeListener } from '../../src/main/ipc/senderGuard';
import { createReaderStateStore } from '../../src/main/persistence/readerStateStore';
import { createReaderStateService } from '../../src/main/state/readerStateService';
import type { ReaderStateService } from '../../src/main/state/readerStateService';

/**
 * The boundary, end to end, over a real filesystem (M7.2, ADR-034).
 *
 * Every other test in this slice injects its filesystem. This one does
 * not: it makes real files in a real temporary directory, fails them in
 * real ways, and follows the result through the real reader-state
 * service, the real IPC registrar and the real `structuredClone` the
 * channel performs, up to the last value the main process produces — the
 * reply the renderer receives. What the renderer then writes on the
 * screen is a pure function of that reply, and is covered next to it in
 * `src/renderer/src/reader/documentFailure.test.ts`; this file guards the
 * half that touches the disk.
 *
 * It exists because the protection M7.2 relies on is structural — a
 * closed union of five reason codes — and a structural guarantee is only
 * worth what an end-to-end check says it is worth. If someone ever
 * widens the failure arm back to a free-form string, a unit test with a
 * fake `stat` can still pass while this one fails, because the real
 * `ENOENT` carries the real absolute path of the real temporary
 * directory, and that directory's name is asserted absent below.
 *
 * It is deliberately not a grep over the source tree. It is the actual
 * value that actually crosses the actual channel.
 */

/** Everything that may never appear in anything the renderer can see. */
const FORBIDDEN = [
  '/',
  '\\',
  'ENOENT',
  'EACCES',
  'EISDIR',
  'EPERM',
  'errno',
  'syscall',
  'Error:',
  'no such file',
  'permission denied',
  'file://',
  'at Object.',
];

const fileSystem: FileSystemAccess = {
  stat: async (path) => stat(path),
  readFile: async (path) => new Uint8Array(await readFile(path)),
};

const trustedSender = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };

/** The registrar the main process uses, with the handlers kept for calling. */
const createIpc = (): IpcHandlerRegistrar & {
  readonly handlers: Map<string, IpcInvokeListener>;
} => {
  const handlers = new Map<string, IpcInvokeListener>();

  return {
    handlers,
    handle(channel, listener): void {
      handlers.set(channel, listener);
    },
  };
};

let directory = '';

/** Paths prepared once; each one fails in a different real way. */
const paths = {
  missing: '',
  unreadable: '',
  folder: '',
  huge: '',
  readable: '',
};

/** True when the process can read a file whose mode is 000 (i.e. root). */
let runningAsRoot = false;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'm72-failure-vocabulary-'));

  paths.missing = join(directory, 'moved-away.pdf');
  paths.unreadable = join(directory, 'locked.pdf');
  paths.folder = join(directory, 'books');
  paths.huge = join(directory, 'enormous.pdf');
  paths.readable = join(directory, 'fine.pdf');

  await writeFile(paths.readable, '%PDF-1.7\n');
  await mkdir(paths.folder);

  await writeFile(paths.unreadable, '%PDF-1.7\n');
  await chmod(paths.unreadable, 0o000);
  runningAsRoot = await readFile(paths.unreadable)
    .then(() => true)
    .catch(() => false);

  // A sparse file: one byte over the limit without writing 256 MB.
  await writeFile(paths.huge, '');
  await truncate(paths.huge, MAX_DOCUMENT_BYTES + 1);
}, 120_000);

afterAll(async () => {
  await chmod(paths.unreadable, 0o600).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

/** Asserts a value carries nothing from the machine, at any depth. */
const expectNothingRaw = (label: string, value: unknown): void => {
  const serialised = JSON.stringify(value) ?? '';

  for (const token of FORBIDDEN) {
    expect({ label, token, serialised }).toStrictEqual({
      label,
      token,
      serialised: expect.not.stringContaining(token) as string,
    });
  }

  // The temporary directory's own name is random per run, so finding it
  // anywhere proves a path leaked rather than that a word was reused.
  expect(serialised).not.toContain(directory);
  expect(serialised).not.toContain('m72-failure-vocabulary-');
};

const expectClosedFailure = (result: DocumentRequestResult): DocumentFailureReason => {
  if (result.status !== 'unreadable') {
    throw new Error(`expected a failure, got ${result.status}`);
  }

  expect(DOCUMENT_FAILURE_REASONS).toContain(result.reason);
  expect(typeof result.name === 'string' || result.name === null).toBe(true);

  // The failure arm has exactly three fields. A fourth would be the way a
  // raw detail came back.
  expect(Object.keys(result).sort()).toStrictEqual(['name', 'reason', 'status']);

  return result.reason;
};

describe('a document that cannot be read, over a real filesystem', () => {
  it('reads a real file successfully, so the failures below mean something', async () => {
    const result = await readDocumentFile(paths.readable, fileSystem);

    expect(result.status).toBe('opened');
  });

  it('classifies a file that is not there as missing', async () => {
    const result = await readDocumentFile(paths.missing, fileSystem);

    expect(expectClosedFailure(result)).toBe('missing');
    expectNothingRaw('missing', result);
  });

  it('classifies a file it may not read as unreadable', async () => {
    if (runningAsRoot) {
      // Recorded rather than skipped silently: root can read mode 000, so
      // there is no EACCES to classify on this machine.
      expect(runningAsRoot).toBe(true);

      return;
    }

    const result = await readDocumentFile(paths.unreadable, fileSystem);

    expect(expectClosedFailure(result)).toBe('unreadable');
    expectNothingRaw('unreadable', result);
  });

  it('classifies a folder as not-a-file', async () => {
    const result = await readDocumentFile(paths.folder, fileSystem);

    expect(expectClosedFailure(result)).toBe('not-a-file');
    expectNothingRaw('not-a-file', result);
  });

  it('classifies a file past the size limit as too-large', async () => {
    const result = await readDocumentFile(paths.huge, fileSystem);

    expect(expectClosedFailure(result)).toBe('too-large');
    expectNothingRaw('too-large', result);
  });

  it('keeps the real detail, which is why the reader does not need it', async () => {
    const diagnostics: string[] = [];

    await readDocumentFile(paths.missing, fileSystem, {
      onDiagnostic: (message) => diagnostics.push(message),
    });

    // The log gets the whole truth: the absolute path and the errno. The
    // test asserts the leak exists *here*, because the alternative to
    // showing the reader the path is recording it, not discarding it.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(paths.missing);
    expect(diagnostics[0]).toContain('ENOENT');
  });
});

describe('the same failures after the service, the channel and the renderer', () => {
  /** The real service over a real store in the same temporary directory. */
  const service = (): ReaderStateService =>
    createReaderStateService({
      store: createReaderStateStore({
        filePath: join(directory, 'reader-state.json'),
        files: {
          readFile: async (path) => readFile(path, 'utf8'),
          writeFile: async (path, contents) => writeFile(path, contents, 'utf8'),
          rename: async (from, to) => rename(from, to),
        },
        onWarning: () => undefined,
        writeDelayMs: 0,
      }),
      readDocument: (path) => readDocumentFile(path, fileSystem),
      exists: (path) =>
        stat(path)
          .then(() => true)
          .catch(() => false),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

  const cases: readonly (readonly [string, keyof typeof paths, DocumentFailureReason])[] = [
    ['a file that is not there', 'missing', 'missing'],
    ['a folder', 'folder', 'not-a-file'],
    ['a file past the size limit', 'huge', 'too-large'],
  ];

  for (const [label, key, reason] of cases) {
    it(`carries ${label} to the renderer as ${reason}, and nothing else`, async () => {
      const ipc = createIpc();
      const subject = service();

      registerDocumentIpcHandlers(ipc, {
        chooseDocument: () => subject.openPath(paths[key]),
        initialDocument: () => subject.openPath(paths[key]),
        openRecentDocument: (id) => subject.openRecent(id),
        openDroppedDocument: () => undefined,
        devServerOrigin: null,
      });

      for (const channel of [IpcChannel.OpenDocumentDialog, IpcChannel.GetInitialDocument]) {
        const handler = ipc.handlers.get(channel);

        expect(handler).toBeDefined();

        // `structuredClone` is what Electron does to a reply. Anything
        // that survives it is exactly what the renderer receives.
        const reply = structuredClone((await handler?.(trustedSender)) as DocumentRequestResult);

        expect(expectClosedFailure(reply)).toBe(reason);
        expectNothingRaw(`${channel} ${label}`, reply);
      }
    });
  }

  it('preserves the historical R2 boundary for a real missing absolute path', async () => {
    const privatePath = join(directory, 'm74-r2-private-sentinel', 'secret-document.pdf');
    const ipc = createIpc();
    const subject = service();

    registerDocumentIpcHandlers(ipc, {
      chooseDocument: () => subject.openPath(privatePath),
      initialDocument: () => subject.openPath(privatePath),
      openRecentDocument: (id) => subject.openRecent(id),
      openDroppedDocument: () => undefined,
      devServerOrigin: null,
    });

    const reply = structuredClone(
      (await ipc.handlers.get(IpcChannel.OpenDocumentDialog)?.(
        trustedSender,
      )) as DocumentRequestResult,
    );

    expect(expectClosedFailure(reply)).toBe('missing');
    expect(reply.status === 'unreadable' && reply.name).toBe('secret-document.pdf');
    expectNothingRaw('historical R2 missing absolute path', reply);
  });

  it('says the same about an unreadable file as about a missing one: nothing raw', async () => {
    if (runningAsRoot) {
      expect(runningAsRoot).toBe(true);

      return;
    }

    const ipc = createIpc();
    const subject = service();

    registerDocumentIpcHandlers(ipc, {
      chooseDocument: () => subject.openPath(paths.unreadable),
      initialDocument: () => subject.openPath(paths.unreadable),
      openRecentDocument: (id) => subject.openRecent(id),
      openDroppedDocument: () => undefined,
      devServerOrigin: null,
    });

    const reply = structuredClone(
      (await ipc.handlers.get(IpcChannel.OpenDocumentDialog)?.(
        trustedSender,
      )) as DocumentRequestResult,
    );

    expect(expectClosedFailure(reply)).toBe('unreadable');
    expect(reply.status === 'unreadable' && reply.name).toBe('locked.pdf');
    expectNothingRaw('unreadable over the channel', reply);
  });

  it('keeps the name of the file, because that is the one detail a reader needs', async () => {
    const ipc = createIpc();
    const subject = service();

    registerDocumentIpcHandlers(ipc, {
      chooseDocument: () => subject.openPath(paths.missing),
      initialDocument: () => subject.openPath(paths.missing),
      openRecentDocument: (id) => subject.openRecent(id),
      openDroppedDocument: () => undefined,
      devServerOrigin: null,
    });

    const reply = (await ipc.handlers.get(IpcChannel.OpenDocumentDialog)?.(
      trustedSender,
    )) as DocumentRequestResult;

    // The file's own name, and nothing around it: no directory, no
    // extension-stripping, no invention.
    expect(reply.status === 'unreadable' && reply.name).toBe('moved-away.pdf');
    expectNothingRaw('name of a missing file', reply);
  });

  it('removes a recent entry whose file disappeared, and reports it as missing', async () => {
    const vanishing = join(directory, 'temporary.pdf');

    await writeFile(vanishing, '%PDF-1.7\n');

    const subject = service();
    const opened = await subject.openPath(vanishing);

    if (opened.status !== 'opened') {
      throw new Error('the fixture document should have opened');
    }

    const id = opened.document.id;

    await rm(vanishing);

    const reply = await subject.openRecent(id);

    expect(expectClosedFailure(reply)).toBe('missing');
    expectNothingRaw('recent open after deletion', reply);

    // And the entry is gone from the snapshot, which is the pre-M7.2
    // behaviour this slice had to leave intact.
    const snapshot = await subject.snapshot();

    expect(snapshot.recents.map((entry) => entry.id)).not.toContain(id);
    expectNothingRaw('snapshot', snapshot);
  });

  it('answers an id it has never heard of without inventing a path', async () => {
    const subject = service();
    const reply = await subject.openRecent('not-an-id-this-store-knows');

    expect(expectClosedFailure(reply)).toBe('missing');
    expectNothingRaw('unknown id', reply);
  });
});
