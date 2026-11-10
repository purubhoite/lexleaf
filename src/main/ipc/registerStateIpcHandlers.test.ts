import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES, type Preferences } from '@core/persistence/preferences';
import { IpcChannel } from '@shared/ipc/channels';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { ReaderStateSnapshot } from '@shared/ipc/contracts';

import { registerStateIpcHandlers, type StateIpcOptions } from './registerStateIpcHandlers';
import type { IpcHandlerRegistrar, IpcInvokeListener } from './senderGuard';

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

const snapshot: ReaderStateSnapshot = {
  ...EMPTY_READER_STATE_SNAPSHOT,
  recents: [
    {
      id: 'id-a',
      name: 'a.pdf',
      sizeBytes: 10,
      pageCount: 4,
      lastPage: 2,
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      available: true,
    },
  ],
  lastDocumentId: 'id-a',
};

const trustedSender = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };

const position = {
  documentId: 'id-a',
  position: { page: 5, pageOffsetFraction: 0.5, zoom: { mode: 'fit-width', scale: 1 } },
  pageCount: 40,
};

const options = (overrides: Partial<StateIpcOptions> = {}): StateIpcOptions => ({
  snapshot: () => Promise.resolve(snapshot),
  savePosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  onRejected: () => undefined,
  devServerOrigin: null,
  ...overrides,
});

describe('registerStateIpcHandlers', () => {
  it('registers exactly the four reading-state channels', () => {
    const ipc = createIpc();

    registerStateIpcHandlers(ipc, options());

    expect([...ipc.handlers.keys()]).toEqual([
      IpcChannel.GetReaderState,
      IpcChannel.SaveReadingPosition,
      IpcChannel.SavePreferences,
      IpcChannel.ForgetDocument,
    ]);
  });

  it('returns the snapshot to a trusted sender', async () => {
    const ipc = createIpc();

    registerStateIpcHandlers(ipc, options());

    await expect(ipc.handlers.get(IpcChannel.GetReaderState)?.(trustedSender)).resolves.toEqual(
      snapshot,
    );
  });

  it('saves a well-formed position', async () => {
    const ipc = createIpc();
    const savePosition = vi.fn(() => Promise.resolve('ok' as const));

    registerStateIpcHandlers(ipc, options({ savePosition }));

    await ipc.handlers.get(IpcChannel.SaveReadingPosition)?.(trustedSender, position);

    expect(savePosition).toHaveBeenCalledWith(position);
  });

  it('ignores a malformed position instead of writing it or failing', async () => {
    const ipc = createIpc();
    const savePosition = vi.fn(() => Promise.resolve('ok' as const));
    const onRejected = vi.fn();

    registerStateIpcHandlers(ipc, options({ savePosition, onRejected }));

    const handler = ipc.handlers.get(IpcChannel.SaveReadingPosition);

    await handler?.(trustedSender, { documentId: '', position: null });
    await handler?.(trustedSender, 'nonsense');
    await handler?.(trustedSender, { ...position, position: { page: 0 } });
    await handler?.(trustedSender);

    expect(savePosition).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(4);
  });

  it('forgets a document by id', async () => {
    const ipc = createIpc();
    const forgetDocument = vi.fn(() => Promise.resolve('ok' as const));

    registerStateIpcHandlers(ipc, options({ forgetDocument }));

    await ipc.handlers.get(IpcChannel.ForgetDocument)?.(trustedSender, 'id-a');

    expect(forgetDocument).toHaveBeenCalledWith('id-a');
  });

  it('ignores a malformed document id', async () => {
    const ipc = createIpc();
    const forgetDocument = vi.fn(() => Promise.resolve('ok' as const));
    const onRejected = vi.fn();

    registerStateIpcHandlers(ipc, options({ forgetDocument, onRejected }));

    await ipc.handlers.get(IpcChannel.ForgetDocument)?.(trustedSender, { id: 'id-a' });

    expect(forgetDocument).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith('a malformed document id was ignored');
  });

  /* ---------------------------------------------------------------- *
   * M7.2: the three writing channels answer with the health of the write
   * ---------------------------------------------------------------- */

  it('answers each writing channel with the health the service reported', async () => {
    const ipc = createIpc();

    registerStateIpcHandlers(
      ipc,
      options({
        savePosition: () => Promise.resolve('failing' as const),
        savePreferences: () => Promise.resolve('failing' as const),
        forgetDocument: () => Promise.resolve('failing' as const),
      }),
    );

    await expect(
      ipc.handlers.get(IpcChannel.SaveReadingPosition)?.(trustedSender, position),
    ).resolves.toBe('failing');
    await expect(
      ipc.handlers.get(IpcChannel.SavePreferences)?.(trustedSender, DEFAULT_PREFERENCES),
    ).resolves.toBe('failing');
    await expect(
      ipc.handlers.get(IpcChannel.ForgetDocument)?.(trustedSender, 'id-a'),
    ).resolves.toBe('failing');
  });

  it('answers ok when the write reached the disk', async () => {
    const ipc = createIpc();

    registerStateIpcHandlers(ipc, options());

    await expect(
      ipc.handlers.get(IpcChannel.SaveReadingPosition)?.(trustedSender, position),
    ).resolves.toBe('ok');
  });

  it('does not report a disk problem when the renderer sent nonsense', async () => {
    // Nothing was written, and nothing is wrong with the disk. Answering
    // `failing` here would put a persistence notice in front of the
    // reader on the strength of a renderer bug.
    const ipc = createIpc();
    const onRejected = vi.fn();

    registerStateIpcHandlers(ipc, options({ onRejected }));

    await expect(
      ipc.handlers.get(IpcChannel.SaveReadingPosition)?.(trustedSender, 'nonsense'),
    ).resolves.toBe('ok');
    await expect(ipc.handlers.get(IpcChannel.SavePreferences)?.(trustedSender, 42)).resolves.toBe(
      'ok',
    );
    await expect(
      ipc.handlers.get(IpcChannel.ForgetDocument)?.(trustedSender, { id: 'x' }),
    ).resolves.toBe('ok');
    expect(onRejected).toHaveBeenCalledTimes(3);
  });

  it('says nothing about the disk beyond the two words it is allowed to say', async () => {
    const ipc = createIpc();

    registerStateIpcHandlers(
      ipc,
      options({ savePosition: () => Promise.resolve('failing' as const) }),
    );

    const reply = await ipc.handlers.get(IpcChannel.SaveReadingPosition)?.(trustedSender, position);

    // The health is a closed two-value vocabulary, not a message: there
    // is no room in it for a path, an errno or an exception string.
    expect(['ok', 'failing']).toContain(reply);
  });

  it('refuses every channel when the sender is not this application', () => {
    const ipc = createIpc();
    const savePosition = vi.fn(() => Promise.resolve('ok' as const));

    registerStateIpcHandlers(ipc, options({ savePosition }));

    for (const channel of [
      IpcChannel.GetReaderState,
      IpcChannel.SaveReadingPosition,
      IpcChannel.SavePreferences,
      IpcChannel.ForgetDocument,
    ]) {
      expect(() =>
        ipc.handlers.get(channel)?.({ senderFrame: { url: 'https://example.com/' } }, position),
      ).toThrow(/untrusted sender/u);
    }

    expect(savePosition).not.toHaveBeenCalled();
  });

  it('refuses a request with no sender frame at all', () => {
    const ipc = createIpc();

    registerStateIpcHandlers(ipc, options());

    expect(() => ipc.handlers.get(IpcChannel.GetReaderState)?.({ senderFrame: null })).toThrow(
      /untrusted sender/u,
    );
  });

  it('accepts the dev server origin when one is configured', async () => {
    const ipc = createIpc();

    registerStateIpcHandlers(ipc, options({ devServerOrigin: 'http://localhost:5173' }));

    await expect(
      ipc.handlers.get(IpcChannel.GetReaderState)?.({
        senderFrame: { url: 'http://localhost:5173/index.html' },
      }),
    ).resolves.toEqual(snapshot);
  });
  /* ---------------------------------------------------------------- *
   * Preferences (ADR-031, 6.8)
   * ---------------------------------------------------------------- */

  it('saves the four preferences from a trusted sender', async () => {
    const ipc = createIpc();
    const savePreferences = vi.fn(() => Promise.resolve('ok' as const));

    registerStateIpcHandlers(ipc, options({ savePreferences }));

    await ipc.handlers.get(IpcChannel.SavePreferences)?.(trustedSender, {
      appearance: 'dark',
      reduceMotion: 'always',
      defaultZoomMode: 'fit-page',
      showDeveloperDiagnostics: 'on',
    });

    expect(savePreferences).toHaveBeenCalledWith({
      appearance: 'dark',
      reduceMotion: 'always',
      defaultZoomMode: 'fit-page',
      showDeveloperDiagnostics: 'on',
    });
  });

  it('refuses a preferences request from an untrusted sender', () => {
    const ipc = createIpc();
    const savePreferences = vi.fn(() => Promise.resolve('ok' as const));

    registerStateIpcHandlers(ipc, options({ savePreferences }));

    expect(() =>
      ipc.handlers.get(IpcChannel.SavePreferences)?.(
        { senderFrame: { url: 'https://example.com/' } },
        { appearance: 'dark' },
      ),
    ).toThrow(/untrusted sender/u);
    expect(() =>
      ipc.handlers.get(IpcChannel.SavePreferences)?.({ senderFrame: null }, { appearance: 'dark' }),
    ).toThrow(/untrusted sender/u);
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('ignores a preferences payload that is not an object', async () => {
    const ipc = createIpc();
    const savePreferences = vi.fn(() => Promise.resolve('ok' as const));
    const onRejected = vi.fn();

    registerStateIpcHandlers(ipc, options({ savePreferences, onRejected }));

    const handler = ipc.handlers.get(IpcChannel.SavePreferences);

    await handler?.(trustedSender, 'dark');
    await handler?.(trustedSender, 42);
    await handler?.(trustedSender, null);
    await handler?.(trustedSender, ['dark']);
    await handler?.(trustedSender);

    expect(savePreferences).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(5);
    expect(onRejected).toHaveBeenCalledWith('a malformed preferences payload was ignored');
  });

  it('normalises an unknown value rather than storing it', async () => {
    const ipc = createIpc();
    const savePreferences = vi.fn(() => Promise.resolve('ok' as const));

    registerStateIpcHandlers(ipc, options({ savePreferences }));

    await ipc.handlers.get(IpcChannel.SavePreferences)?.(trustedSender, {
      appearance: 'neon',
      reduceMotion: 'always',
    });

    expect(savePreferences).toHaveBeenCalledWith({
      appearance: 'system',
      reduceMotion: 'always',
      defaultZoomMode: 'fit-width',
      showDeveloperDiagnostics: 'off',
    });
  });

  it('drops anything the renderer adds to the payload', async () => {
    /*
     * The security property of this channel: the renderer cannot use it
     * to put a key, a URL or a path into the state file, because the
     * handler keeps the four fields it knows and nothing else.
     */
    const ipc = createIpc();
    const savePreferences = vi.fn<(preferences: Preferences) => Promise<'ok'>>(() =>
      Promise.resolve('ok' as const),
    );

    registerStateIpcHandlers(ipc, options({ savePreferences }));

    await ipc.handlers.get(IpcChannel.SavePreferences)?.(trustedSender, {
      appearance: 'light',
      apiKey: 'sk-live-should-not-pass',
      providerUrl: 'https://provider.invalid/v1/chat',
      documentPath: '/home/reader/private.pdf',
      '../../etc/passwd': 'x',
    });

    const stored = savePreferences.mock.calls[0]?.[0];

    expect(Object.keys(stored ?? {})).toStrictEqual([
      'appearance',
      'reduceMotion',
      'defaultZoomMode',
      'showDeveloperDiagnostics',
    ]);
    expect(JSON.stringify(stored)).not.toContain('sk-live-should-not-pass');
    expect(JSON.stringify(stored)).not.toContain('provider.invalid');
    expect(JSON.stringify(stored)).not.toContain('private.pdf');
    expect(JSON.stringify(stored)).not.toContain('passwd');
  });
});
