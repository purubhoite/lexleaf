import { describe, expect, it, vi } from 'vitest';

import { EMPTY_ANNOTATIONS, type AnnotationsExportOutcome } from '@core/annotations/annotations';
import { IpcChannel } from '@shared/ipc/channels';

import type { AnnotationStore } from '../annotations/annotationStore';

import { registerAnnotationIpcHandlers } from './registerAnnotationIpcHandlers';
import type { IpcInvokeListener } from './senderGuard';

const TRUSTED = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };
const UNTRUSTED = { senderFrame: { url: 'https://example.com/' } };

const setup = (): {
  readonly call: (channel: string, event: typeof TRUSTED, ...args: unknown[]) => unknown;
  readonly channels: () => string[];
  readonly load: ReturnType<typeof vi.fn<AnnotationStore['load']>>;
  readonly save: ReturnType<typeof vi.fn<AnnotationStore['save']>>;
  readonly exportDocument: ReturnType<
    typeof vi.fn<(documentId: string) => Promise<AnnotationsExportOutcome>>
  >;
} => {
  const listeners = new Map<string, IpcInvokeListener>();
  const load = vi.fn<AnnotationStore['load']>(() => Promise.resolve(EMPTY_ANNOTATIONS));
  const save = vi.fn<AnnotationStore['save']>(() => Promise.resolve(true));
  const exportDocument = vi.fn<(documentId: string) => Promise<AnnotationsExportOutcome>>(() =>
    Promise.resolve({ status: 'empty' }),
  );

  registerAnnotationIpcHandlers(
    {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
    },
    {
      store: { load, save, nameOf: () => Promise.resolve(null) },
      exportDocument,
      devServerOrigin: null,
    },
  );

  return {
    call: (channel, event, ...args) => listeners.get(channel)?.(event, ...args),
    channels: () => [...listeners.keys()],
    load,
    save,
    exportDocument,
  };
};

describe('registerAnnotationIpcHandlers', () => {
  it('registers exactly the three annotation channels', () => {
    expect(setup().channels()).toStrictEqual([
      'annotations:load',
      'annotations:save',
      'annotations:export',
    ]);
  });

  it('refuses every channel to an untrusted sender', () => {
    const { call, channels, load, save, exportDocument } = setup();

    for (const channel of channels()) {
      expect(() => call(channel, UNTRUSTED, 'doc-1', 'x', {})).toThrow(/untrusted sender/u);
    }

    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(exportDocument).not.toHaveBeenCalled();
  });

  it('loads, saves and exports for a document named by its identity', async () => {
    const { call, load, save, exportDocument } = setup();

    await call(IpcChannel.AnnotationsLoad, TRUSTED, 'doc-1');
    await call(IpcChannel.AnnotationsSave, TRUSTED, 'doc-1', 'Harbour.pdf', { highlights: [] });
    await call(IpcChannel.AnnotationsExport, TRUSTED, 'doc-1');

    expect(load).toHaveBeenCalledWith('doc-1');
    expect(save).toHaveBeenCalledWith('doc-1', 'Harbour.pdf', { highlights: [] });
    expect(exportDocument).toHaveBeenCalledWith('doc-1');
  });

  it('touches nothing for an identity that is not one', async () => {
    const { call, load, save, exportDocument } = setup();

    for (const bad of ['', '__proto__', 7, null, { id: 'doc-1' }]) {
      expect(await call(IpcChannel.AnnotationsLoad, TRUSTED, bad)).toStrictEqual(EMPTY_ANNOTATIONS);
      expect(await call(IpcChannel.AnnotationsSave, TRUSTED, bad, 'x', {})).toBe(false);
      expect(await call(IpcChannel.AnnotationsExport, TRUSTED, bad)).toStrictEqual({
        status: 'failed',
      });
    }

    expect(await call(IpcChannel.AnnotationsSave, TRUSTED, 'doc-1', 7, {})).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(exportDocument).not.toHaveBeenCalled();
  });

  it('answers calmly when the store fails', async () => {
    const { call, load, save } = setup();

    load.mockRejectedValueOnce(new Error('boom'));
    save.mockRejectedValueOnce(new Error('boom'));

    expect(await call(IpcChannel.AnnotationsLoad, TRUSTED, 'doc-1')).toStrictEqual(
      EMPTY_ANNOTATIONS,
    );
    expect(await call(IpcChannel.AnnotationsSave, TRUSTED, 'doc-1', 'x', {})).toBe(false);
  });
});
