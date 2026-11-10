import { describe, expect, it, vi } from 'vitest';

import { IpcChannel } from '@shared/ipc/channels';
import type { DocumentRequestResult } from '@shared/ipc/contracts';

import type { IpcHandlerRegistrar } from './registerAppIpcHandlers';
import {
  registerDocumentIpcHandlers,
  type DocumentIpcOptions,
} from './registerDocumentIpcHandlers';

type Handler = (
  event: { readonly senderFrame: { readonly url: string } | null },
  ...args: unknown[]
) => unknown;

interface FakeIpc extends IpcHandlerRegistrar {
  readonly handlers: Map<string, Handler>;
}

const createIpc = (): FakeIpc => {
  const handlers = new Map<string, Handler>();

  return {
    handlers,
    handle(channel, listener): void {
      handlers.set(channel, listener);
    },
  };
};

const opened: DocumentRequestResult = {
  status: 'opened',
  document: {
    id: 'content-hash',
    name: 'harbour.pdf',
    sizeBytes: 3,
    bytes: new Uint8Array([1, 2, 3]),
    position: null,
  },
};

const options = (overrides: Partial<DocumentIpcOptions> = {}): DocumentIpcOptions => ({
  chooseDocument: () => Promise.resolve(opened),
  initialDocument: () => Promise.resolve({ status: 'none' } as const),
  openRecentDocument: () => Promise.resolve(opened),
  devServerOrigin: null,
  ...overrides,
});

const trustedSender = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };

describe('registerDocumentIpcHandlers', () => {
  it('registers exactly the three document channels', () => {
    const ipc = createIpc();

    registerDocumentIpcHandlers(ipc, options());

    expect([...ipc.handlers.keys()]).toEqual([
      IpcChannel.OpenDocumentDialog,
      IpcChannel.GetInitialDocument,
      IpcChannel.OpenRecentDocument,
    ]);
  });

  it('returns the chosen document to a trusted sender', async () => {
    const ipc = createIpc();

    registerDocumentIpcHandlers(ipc, options());

    await expect(ipc.handlers.get(IpcChannel.OpenDocumentDialog)?.(trustedSender)).resolves.toEqual(
      opened,
    );
  });

  it('returns the command line document to a trusted sender', async () => {
    const ipc = createIpc();

    registerDocumentIpcHandlers(
      ipc,
      options({
        chooseDocument: () => Promise.resolve({ status: 'none' } as const),
        initialDocument: () => Promise.resolve(opened),
      }),
    );

    await expect(ipc.handlers.get(IpcChannel.GetInitialDocument)?.(trustedSender)).resolves.toEqual(
      opened,
    );
  });

  it('refuses a request from an untrusted frame without opening anything', () => {
    const ipc = createIpc();
    const chooseDocument = vi.fn(() => Promise.resolve(opened));

    registerDocumentIpcHandlers(ipc, options({ chooseDocument }));

    expect(() =>
      ipc.handlers.get(IpcChannel.OpenDocumentDialog)?.({
        senderFrame: { url: 'https://example.com/' },
      }),
    ).toThrow(/untrusted sender/u);
    expect(chooseDocument).not.toHaveBeenCalled();
  });

  it('refuses a request with no sender frame', () => {
    const ipc = createIpc();

    registerDocumentIpcHandlers(ipc, options());

    expect(() => ipc.handlers.get(IpcChannel.GetInitialDocument)?.({ senderFrame: null })).toThrow(
      /untrusted sender/u,
    );
  });

  it('accepts the dev server origin while developing', async () => {
    const ipc = createIpc();

    registerDocumentIpcHandlers(ipc, options({ devServerOrigin: 'http://localhost:5173' }));

    await expect(
      ipc.handlers.get(IpcChannel.OpenDocumentDialog)?.({
        senderFrame: { url: 'http://localhost:5173/index.html' },
      }),
    ).resolves.toEqual(opened);
  });

  it('reopens a recent document by id', async () => {
    const ipc = createIpc();
    const openRecentDocument = vi.fn(() => Promise.resolve(opened));

    registerDocumentIpcHandlers(ipc, options({ openRecentDocument }));

    await expect(
      ipc.handlers.get(IpcChannel.OpenRecentDocument)?.(trustedSender, 'content-hash'),
    ).resolves.toEqual(opened);
    expect(openRecentDocument).toHaveBeenCalledWith('content-hash');
  });

  it('refuses a malformed document id without reaching the store', async () => {
    const ipc = createIpc();
    const openRecentDocument = vi.fn(() => Promise.resolve(opened));

    registerDocumentIpcHandlers(ipc, options({ openRecentDocument }));

    await expect(
      ipc.handlers.get(IpcChannel.OpenRecentDocument)?.(trustedSender, { path: '/etc/passwd' }),
    ).resolves.toEqual({
      status: 'unreadable',
      reason: 'unknown',
      name: null,
    });
    expect(openRecentDocument).not.toHaveBeenCalled();
  });
});
