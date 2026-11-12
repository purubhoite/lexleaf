import {
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseReaderState } from '@core/persistence/schema';
import type { DocumentRequestResult } from '@shared/ipc/contracts';

import { createReaderStateStore } from '../../src/main/persistence/readerStateStore';
import { createReaderStateService } from '../../src/main/state/readerStateService';
import { createForwardedDocumentQueue } from '../../src/main/lifecycle/forwardedDocuments';
import {
  claimSingleInstance,
  type SingleInstanceApp,
} from '../../src/main/lifecycle/singleInstance';

/**
 * C-1 end to end, without a renderer.
 *
 * Everything below the window is real: the store writes real files, the
 * reader-state service records real opens, and the forwarded documents
 * travel the same route they travel in `src/main/index.ts` — the queue
 * delivers, a "reload" makes the window ask `initialDocument`, and the
 * handler's answer is what completes the request.
 *
 * The window is the one thing simulated, because the thing being proved
 * is precisely that the main process does not get ahead of it.
 */

let workspace = '';

const realFiles = {
  readFile: async (path: string): Promise<string> => readFile(path, 'utf8'),
  writeFile: async (path: string, contents: string): Promise<void> =>
    writeFile(path, contents, 'utf8'),
  rename: async (from: string, to: string): Promise<void> => rename(from, to),
  syncFile: async (path: string): Promise<void> => {
    const handle = await openFile(path, 'r+');

    try {
      await handle.datasync();
    } finally {
      await handle.close();
    }
  },
  syncDirectory: async (path: string): Promise<void> => {
    const handle = await openFile(path, 'r');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  remove: async (path: string): Promise<void> => unlink(path),
};

interface Application {
  /** What a second launch does: forwards a path and exits. */
  forward(path: string): void;
  /** The renderer finishing a load and asking for its document. */
  rendererLoads(): Promise<void>;
  /** Pending loads this window owes, in order. */
  pendingLoads(): number;
  /** True when nothing is queued, in flight, or owed to the window. */
  idle(): boolean;
  flush(): Promise<void>;
  readState(): Promise<string[]>;
  tempFiles(): Promise<string[]>;
  readonly opened: string[];
  readonly failures: DocumentRequestResult[];
  readonly directory: string;
  queueState(): { depth: number; inFlight: string | null };
}

/**
 * The main process as it is wired in `index.ts`, minus Electron.
 *
 * `reload` does not synchronously produce a renderer request — that is
 * the whole hazard — so loads are queued here and driven by the test.
 */
const startApplication = async (
  initial: string,
  options: { deliveryDelayMs?: number; rendererResponds?: boolean } = {},
): Promise<Application> => {
  const directory = await mkdtemp(join(workspace, 'app-'));
  const deliveryDelayMs = options.deliveryDelayMs ?? 0;
  const rendererResponds = options.rendererResponds ?? true;
  const filePath = join(directory, 'reader-state.json');

  const store = createReaderStateStore({
    filePath,
    files: realFiles,
    onWarning: () => undefined,
    writeDelayMs: 5,
  });

  await store.load();

  let counter = 0;
  const service = createReaderStateService({
    store,
    readDocument: (path: string) => {
      counter += 1;

      return Promise.resolve({
        status: 'opened',
        document: {
          id: `id-${path}`,
          name: path.split('/').pop() ?? path,
          pageCount: 3,
          sizeBytes: 10,
          openedAt: `2026-01-0${String(counter)}T00:00:00.000Z`,
        },
        bytes: new Uint8Array([1, 2, 3]).buffer,
      } as unknown as DocumentRequestResult);
    },
    exists: () => Promise.resolve(true),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

  let requestedDocumentPath: string | null = initial;
  const opened: string[] = [];
  const failures: DocumentRequestResult[] = [];
  let pending = 0;

  const queue = createForwardedDocumentQueue({
    deliver: async (path: string) => {
      if (deliveryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, deliveryDelayMs));
      }

      requestedDocumentPath = path;
      await service.flush();
      // `webContents.reload()`: asynchronous, and answered later.
      pending += 1;
    },
    onDiagnostic: () => undefined,
  });

  // The real handler, verbatim in shape.
  const initialDocument = async (): Promise<DocumentRequestResult> => {
    const ticket = queue.beginInitialDocumentRequest();

    try {
      if (requestedDocumentPath === null) {
        return { status: 'none' };
      }

      const result = await service.openPath(requestedDocumentPath);

      if (result.status === 'opened') {
        opened.push(requestedDocumentPath);
      } else {
        failures.push(result);
      }

      return result;
    } finally {
      queue.completeInitialDocumentRequest(ticket);
    }
  };

  return {
    forward: (path) => queue.enqueue(path),
    rendererLoads: async (): Promise<void> => {
      if (!rendererResponds) {
        return;
      }

      if (pending > 0) {
        pending -= 1;
      }

      await initialDocument();
    },
    pendingLoads: () => pending,
    idle: () => pending === 0 && queue.depth() === 0 && queue.inFlight() === null,
    flush: async (): Promise<void> => {
      await service.flush();
    },
    readState: async () =>
      parseReaderState(await readFile(filePath, 'utf8')).state.documents.map((entry) => entry.name),
    tempFiles: async () => (await readdir(directory)).filter((entry) => entry.endsWith('.tmp')),
    queueState: () => ({ depth: queue.depth(), inFlight: queue.inFlight() }),
    opened,
    failures,
    directory,
  };
};

const SETTLE_DEADLINE_MS = 1_000;
const SETTLE_POLL_MS = 1;

/** Drives the window until the queue has nothing left to hand over. */
const settle = async (application: Application): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + SETTLE_DEADLINE_MS;

  while (!application.idle()) {
    if (Date.now() >= deadline) {
      const state = application.queueState();
      const elapsedMs = Date.now() - startedAt;

      throw new Error(
        `forwarded documents did not settle after ${String(elapsedMs)}ms ` +
          `(deadline ${String(SETTLE_DEADLINE_MS)}ms): ` +
          JSON.stringify({
            pendingLoads: application.pendingLoads(),
            queueDepth: state.depth,
            inFlight: state.inFlight,
            opened: application.opened,
            failures: application.failures,
          }),
      );
    }

    if (application.pendingLoads() > 0) {
      await application.rendererLoads();
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }
};

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'forwarded-documents-'));
});

afterAll(async () => {
  await Promise.resolve();
});

describe('documents forwarded by later launches (C-1)', () => {
  it('opens all four of a back-to-back burst, in order, losing none', async () => {
    const application = await startApplication('/books/first.pdf');

    await application.rendererLoads();

    // Four launches with nothing in between: the audit's exact failure.
    application.forward('/books/two.pdf');
    application.forward('/books/three.pdf');
    application.forward('/books/four.pdf');
    application.forward('/books/five.pdf');

    await settle(application);
    await application.flush();

    expect(application.opened).toEqual([
      '/books/first.pdf',
      '/books/two.pdf',
      '/books/three.pdf',
      '/books/four.pdf',
      '/books/five.pdf',
    ]);

    // Every document that was asked for is in the persisted recents.
    const recents = await application.readState();

    for (const name of ['first.pdf', 'two.pdf', 'three.pdf', 'four.pdf', 'five.pdf']) {
      expect(recents).toContain(name);
    }

    expect(application.failures).toEqual([]);
    expect(await application.tempFiles()).toEqual([]);
  });

  it('keeps working when the launches are spaced out', async () => {
    const application = await startApplication('/books/first.pdf');

    await application.rendererLoads();

    application.forward('/books/two.pdf');
    await settle(application);

    application.forward('/books/three.pdf');
    await settle(application);

    await application.flush();

    expect(application.opened).toEqual(['/books/first.pdf', '/books/two.pdf', '/books/three.pdf']);
    expect(await application.readState()).toContain('two.pdf');
    expect(await application.readState()).toContain('three.pdf');
  });

  it('does not clobber state that was already on the disk', async () => {
    const application = await startApplication('/books/first.pdf');

    await application.rendererLoads();
    await application.flush();

    const before = await application.readState();

    application.forward('/books/two.pdf');
    application.forward('/books/three.pdf');
    await settle(application);
    await application.flush();

    const after = await application.readState();

    for (const name of before) {
      expect(after).toContain(name);
    }

    expect(await application.tempFiles()).toEqual([]);
  });

  it('a burst arriving while the window is being rebuilt still opens everything', async () => {
    const application = await startApplication('/books/first.pdf');

    // Nothing has loaded yet — the renderer is still coming up, which is
    // what crash recovery looks like from the main process.
    application.forward('/books/two.pdf');
    application.forward('/books/three.pdf');
    application.forward('/books/four.pdf');

    await settle(application);
    await application.flush();

    expect(application.opened).toEqual(['/books/two.pdf', '/books/three.pdf', '/books/four.pdf']);
    expect(application.failures).toEqual([]);
  });

  it('allows slow but valid delivery beyond the old turn guard', async () => {
    const application = await startApplication('/books/first.pdf', { deliveryDelayMs: 250 });

    await application.rendererLoads();
    application.forward('/books/two.pdf');

    await settle(application);

    expect(application.opened).toEqual(['/books/first.pdf', '/books/two.pdf']);
  });

  it('fails with queue diagnostics when renderer consumption is genuinely stuck', async () => {
    const application = await startApplication('/books/first.pdf', { rendererResponds: false });

    await application.rendererLoads();
    application.forward('/books/two.pdf');

    await expect(settle(application)).rejects.toThrow(
      /forwarded documents did not settle after .*pendingLoads.*queueDepth.*inFlight.*two\.pdf/,
    );
  });

  it('a second launch with no document is focus-only: nothing is queued and nothing reloads', async () => {
    const application = await startApplication('/books/first.pdf');

    await application.rendererLoads();
    const loadsBefore = application.pendingLoads();

    let focused = 0;
    const app: SingleInstanceApp = {
      requestSingleInstanceLock: () => true,
      on: (_event, handler) => {
        handler({}, ['/usr/bin/reader'], '/home/reader');
      },
      quit: () => undefined,
    };

    claimSingleInstance({
      app,
      onForwardedDocument: (path) => application.forward(path),
      onFocusRequested: () => {
        focused += 1;
      },
      onDiagnostic: () => undefined,
    });

    expect(focused).toBe(1);
    expect(application.pendingLoads()).toBe(loadsBefore);
  });
});
