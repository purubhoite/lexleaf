import { IpcChannel } from '@shared/ipc/channels';
import { UPDATE_STATE_UNKNOWN, type UpdateIpcState } from '@shared/ipc/updateContracts';
import { describe, expect, it, vi } from 'vitest';

import type { UpdateService } from '../update/updateService';

import { registerUpdateIpcHandlers } from './registerUpdateIpcHandlers';
import type { IpcInvokeListener } from './senderGuard';

const TRUSTED = { senderFrame: { url: 'file:///app/renderer/index.html' } };
const UNTRUSTED = { senderFrame: { url: 'https://example.com/' } };

const AVAILABLE: UpdateIpcState = {
  automatic: true,
  outcome: { status: 'available', version: '0.2.0', canInstall: true },
};

const setup = () => {
  const service: UpdateService = {
    check: vi.fn(() => Promise.resolve(AVAILABLE)),
    setAutomatic: vi.fn((automatic: boolean) =>
      Promise.resolve<UpdateIpcState>({ automatic, outcome: { status: 'idle' } }),
    ),
    download: vi.fn(() => Promise.resolve(AVAILABLE)),
    install: vi.fn(() => Promise.resolve()),
    openDownload: vi.fn(),
  };
  const onRejected = vi.fn();
  const handlers = new Map<string, IpcInvokeListener>();

  registerUpdateIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { service, onRejected, devServerOrigin: null },
  );

  const call = (channel: string, event: typeof TRUSTED, ...args: unknown[]): unknown => {
    const listener = handlers.get(channel);

    if (listener === undefined) {
      throw new Error(`no handler for ${channel}`);
    }

    return listener(event, ...args);
  };

  return { service, onRejected, handlers, call };
};

describe('the update channels', () => {
  it('registers exactly five', () => {
    expect([...setup().handlers.keys()]).toStrictEqual([
      IpcChannel.UpdateCheck,
      IpcChannel.UpdateSetAutomatic,
      IpcChannel.UpdateDownload,
      IpcChannel.UpdateInstall,
      IpcChannel.UpdateOpenDownload,
    ]);
  });

  it('passes a check request through as one boolean', async () => {
    const { service, call } = setup();

    expect(await call(IpcChannel.UpdateCheck, TRUSTED, { manual: true, address: 'x' })).toBe(
      AVAILABLE,
    );
    expect(service.check).toHaveBeenCalledExactlyOnceWith({ manual: true });
  });

  it('stores the setting as one boolean', async () => {
    const { service, call } = setup();

    await call(IpcChannel.UpdateSetAutomatic, TRUSTED, { automatic: false });

    expect(service.setAutomatic).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('ignores malformed requests without reaching the service', async () => {
    const { service, onRejected, call } = setup();

    expect(await call(IpcChannel.UpdateCheck, TRUSTED, 'now')).toBe(UPDATE_STATE_UNKNOWN);
    expect(await call(IpcChannel.UpdateSetAutomatic, TRUSTED, { automatic: 'off' })).toBe(
      UPDATE_STATE_UNKNOWN,
    );
    expect(service.check).not.toHaveBeenCalled();
    expect(service.setAutomatic).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(2);
  });

  it('downloads and installs with no argument from the renderer', async () => {
    const { service, call } = setup();

    expect(await call(IpcChannel.UpdateDownload, TRUSTED, { version: '9.9.9' })).toBe(AVAILABLE);
    await call(IpcChannel.UpdateInstall, TRUSTED, 'https://evil.example/setup.exe');

    expect(service.download).toHaveBeenCalledExactlyOnceWith();
    expect(service.install).toHaveBeenCalledExactlyOnceWith();
  });

  it('opens the download page with no argument from the renderer', () => {
    const { service, call } = setup();

    call(IpcChannel.UpdateOpenDownload, TRUSTED, 'https://evil.example/');

    expect(service.openDownload).toHaveBeenCalledExactlyOnceWith();
  });

  it('refuses every channel to an untrusted sender', () => {
    const { service, call } = setup();

    for (const channel of [
      IpcChannel.UpdateCheck,
      IpcChannel.UpdateSetAutomatic,
      IpcChannel.UpdateDownload,
      IpcChannel.UpdateInstall,
      IpcChannel.UpdateOpenDownload,
    ]) {
      expect(() => call(channel, UNTRUSTED, { manual: true })).toThrow(/untrusted sender/u);
    }

    expect(service.check).not.toHaveBeenCalled();
    expect(service.download).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.openDownload).not.toHaveBeenCalled();
  });
});
