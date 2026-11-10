import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseReaderStateSnapshot,
  SESSION_RECOVERY_STATES,
  type ReaderStateSnapshot,
  type StateWriteHealth,
} from '@shared/ipc/contracts';
import { IpcChannel } from '@shared/ipc/channels';

import { createReaderStateStore } from '../../src/main/persistence/readerStateStore';
import { createReaderStateService } from '../../src/main/state/readerStateService';
import { registerStateIpcHandlers } from '../../src/main/ipc/registerStateIpcHandlers';
import { createRendererRecovery } from '../../src/main/window/rendererRecovery';

/**
 * How the renderer learns it is a replacement, over the real boundary
 * (M7.1, ADR-035).
 *
 * The unit tests either side of this one prove the lifecycle and the
 * notice. This proves the thing between them: that the value the main
 * process computes survives the real state service, the real sender-
 * guarded registrar and `structuredClone`, and that what arrives is one
 * of two words rather than anything about a process that died.
 */

const realStore = async (): Promise<ReturnType<typeof createReaderStateStore>> => {
  const directory = await mkdtemp(join(tmpdir(), 'ipr-recovery-'));

  return createReaderStateStore({
    filePath: join(directory, 'reader-state.json'),
    files: {
      readFile: async (path) => readFile(path, 'utf8'),
      writeFile: async (path, contents) => writeFile(path, contents, 'utf8'),
      rename: async (from, to) => rename(from, to),
    },
    onWarning: () => undefined,
  });
};

/** The real registrar, driven the way the preload drives it. */
const snapshotOverIpc = async (
  service: ReturnType<typeof createReaderStateService>,
): Promise<unknown> => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  registerStateIpcHandlers(
    {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void => {
        handlers.set(channel, handler);
      },
    } as never,
    {
      snapshot: async () => service.snapshot(),
      savePosition: (): Promise<StateWriteHealth> => Promise.resolve('ok'),
      forgetDocument: (): Promise<StateWriteHealth> => Promise.resolve('ok'),
      savePreferences: (): Promise<StateWriteHealth> => Promise.resolve('ok'),
      onRejected: () => undefined,
      devServerOrigin: null,
    },
  );

  const handler = handlers.get(IpcChannel.GetReaderState);
  const event = { senderFrame: { url: 'file:///app/index.html' } };

  return structuredClone(await handler?.(event));
};

const serviceWith = async (
  recovery: ReturnType<typeof createRendererRecovery>,
): Promise<ReturnType<typeof createReaderStateService>> =>
  createReaderStateService({
    store: await realStore(),
    readDocument: () => Promise.resolve({ status: 'none' } as const),
    exists: () => Promise.resolve(true),
    now: () => new Date('2026-10-08T00:00:00.000Z'),
    sessionRecovery: () => recovery.notice(),
  });

const quietRecovery = (): ReturnType<typeof createRendererRecovery> =>
  createRendererRecovery({
    reload: () => undefined,
    onTerminalFailure: () => undefined,
    onDiagnostic: () => undefined,
  });

describe('the session recovery value crossing the real boundary', () => {
  it('is "none" for an ordinary start', async () => {
    const crossed = await snapshotOverIpc(await serviceWith(quietRecovery()));
    const parsed = parseReaderStateSnapshot(crossed);

    expect(parsed?.sessionRecovery).toBe('none');
  });

  it('is "after-crash" for the renderer that replaced a dead one', async () => {
    const recovery = quietRecovery();
    const service = await serviceWith(recovery);

    recovery.onRendererGone({ reason: 'crashed', exitCode: 133 });

    const parsed = parseReaderStateSnapshot(await snapshotOverIpc(service));

    expect(parsed?.sessionRecovery).toBe('after-crash');
  });

  it('is still "after-crash" once the replacement is up, so the notice survives the ask', async () => {
    const recovery = quietRecovery();
    const service = await serviceWith(recovery);

    recovery.onRendererGone({ reason: 'crashed', exitCode: 133 });
    recovery.onRendererReady();

    const parsed = parseReaderStateSnapshot(await snapshotOverIpc(service));

    expect(parsed?.sessionRecovery).toBe('after-crash');
  });

  it('is "none" again once recovery has been given up: there is nothing to reopen', async () => {
    const recovery = quietRecovery();
    const service = await serviceWith(recovery);

    recovery.onRendererGone({ reason: 'crashed', exitCode: 133 });
    recovery.onRendererGone({ reason: 'crashed', exitCode: 133 });

    const parsed = parseReaderStateSnapshot(await snapshotOverIpc(service));

    expect(parsed?.sessionRecovery).toBe('none');
  });

  it('carries no exit code, reason, path or separator in the whole reply', async () => {
    const recovery = quietRecovery();
    const service = await serviceWith(recovery);

    recovery.onRendererGone({ reason: 'oom-killed', exitCode: 133 });

    const serialised = JSON.stringify(await snapshotOverIpc(service));

    // `after-crash` is the approved word and is of course present; what
    // must not be is anything the operating system said. `oom` on its own
    // would match `defaultZoomMode`, which is a reminder that a substring
    // sweep is a weak test: the strong one is that the field is a
    // two-word union, asserted above.
    for (const forbidden of ['oom-killed', '133', 'exitCode', 'SIGSEGV', tmpdir()]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('narrows anything outside the closed set to "none" at the boundary', () => {
    const hostile = parseReaderStateSnapshot({
      recents: [],
      lastDocumentId: null,
      preferences: {},
      sessionRecovery: "crashed: SIGSEGV at '/home/reader/doc.pdf'",
    });

    expect(hostile?.sessionRecovery).toBe('none');
  });

  it('is one of exactly two words', () => {
    expect([...SESSION_RECOVERY_STATES]).toStrictEqual(['none', 'after-crash']);
  });

  it('does not disturb the rest of the snapshot', async () => {
    const parsed: ReaderStateSnapshot | null = parseReaderStateSnapshot(
      await snapshotOverIpc(await serviceWith(quietRecovery())),
    );

    expect(parsed?.recents).toStrictEqual([]);
    expect(parsed?.lastDocumentId).toBeNull();
    expect(parsed?.preferences.appearance).toBe('system');
  });

  it('is never written to the state document on disk', async () => {
    const recovery = quietRecovery();
    const store = await realStore();
    const service = createReaderStateService({
      store,
      readDocument: () => Promise.resolve({ status: 'none' } as const),
      exists: () => Promise.resolve(true),
      now: () => new Date('2026-10-08T00:00:00.000Z'),
      sessionRecovery: () => recovery.notice(),
    });

    recovery.onRendererGone({ reason: 'crashed', exitCode: 133 });
    await service.savePreferences({
      appearance: 'dark',
      reduceMotion: 'system',
      defaultZoomMode: 'fit-width',
      showDeveloperDiagnostics: 'off',
    });
    await service.flush();

    // A crash is a fact about this process, not about the reader's state,
    // so no new persistence mechanism was introduced to carry it.
    const onDisk = JSON.stringify(await service.snapshot());

    expect(onDisk).toContain('after-crash');
    expect(JSON.stringify(store.current())).not.toContain('after-crash');
  });
});
