import { describe, expect, it, vi } from 'vitest';

import { IpcChannel } from '@shared/ipc/channels';
import type { AppInfo } from '@shared/ipc/contracts';

import { registerAppIpcHandlers, type IpcHandlerRegistrar } from './registerAppIpcHandlers';

const appInfo: AppInfo = {
  name: 'Lexleaf',
  version: '0.1.0',
  electronVersion: '41.10.7',
  chromeVersion: '142.0.0.0',
};

interface FakeIpc extends IpcHandlerRegistrar {
  readonly registeredChannels: () => readonly string[];
  readonly invoke: (channel: string, senderUrl: string | null) => unknown;
}

const createFakeIpc = (): FakeIpc => {
  const handlers = new Map<
    string,
    (event: { readonly senderFrame: { readonly url: string } | null }) => unknown
  >();

  return {
    handle(channel, listener): void {
      handlers.set(channel, listener);
    },
    registeredChannels: (): readonly string[] => [...handlers.keys()],
    invoke(channel, senderUrl): unknown {
      const handler = handlers.get(channel);
      if (handler === undefined) {
        throw new Error(`No handler registered for ${channel}.`);
      }
      return handler({ senderFrame: senderUrl === null ? null : { url: senderUrl } });
    },
  };
};

describe('registerAppIpcHandlers', () => {
  it('registers only the approved channels', () => {
    const ipc = createFakeIpc();
    registerAppIpcHandlers(ipc, { appInfo, reportProblem: () => undefined, devServerOrigin: null });

    expect(ipc.registeredChannels()).toEqual([IpcChannel.GetAppInfo, IpcChannel.ReportProblem]);
  });

  it('returns application information to the packaged renderer', () => {
    const ipc = createFakeIpc();
    registerAppIpcHandlers(ipc, { appInfo, reportProblem: () => undefined, devServerOrigin: null });

    expect(ipc.invoke(IpcChannel.GetAppInfo, 'file:///app/out/renderer/index.html')).toEqual(
      appInfo,
    );
  });

  it('returns application information to the dev server renderer', () => {
    const ipc = createFakeIpc();
    registerAppIpcHandlers(ipc, {
      appInfo,
      reportProblem: () => undefined,
      devServerOrigin: 'http://localhost:5173',
    });

    expect(ipc.invoke(IpcChannel.GetAppInfo, 'http://localhost:5173/index.html')).toEqual(appInfo);
  });

  it('rejects a request from an untrusted origin', () => {
    const ipc = createFakeIpc();
    registerAppIpcHandlers(ipc, { appInfo, reportProblem: () => undefined, devServerOrigin: null });

    expect(() => ipc.invoke(IpcChannel.GetAppInfo, 'https://attacker.example')).toThrow(
      /untrusted sender/u,
    );
  });

  it('rejects a request without an identifiable sender', () => {
    const ipc = createFakeIpc();
    registerAppIpcHandlers(ipc, { appInfo, reportProblem: () => undefined, devServerOrigin: null });

    expect(() => ipc.invoke(IpcChannel.GetAppInfo, null)).toThrow(/untrusted sender/u);
  });

  it('opens the problem report for the application, and says whether it could', () => {
    const ipc = createFakeIpc();
    const reportProblem = vi.fn();
    registerAppIpcHandlers(ipc, { appInfo, reportProblem, devServerOrigin: null });

    expect(ipc.invoke(IpcChannel.ReportProblem, 'file:///app/out/renderer/index.html')).toBe(true);
    // Whatever the page sends, nothing of it reaches the report.
    expect(reportProblem).toHaveBeenCalledExactlyOnceWith();
  });

  it('answers false, without throwing, when the report cannot be opened', () => {
    const ipc = createFakeIpc();
    registerAppIpcHandlers(ipc, {
      appInfo,
      reportProblem: () => {
        throw new Error('no browser');
      },
      devServerOrigin: null,
    });

    expect(ipc.invoke(IpcChannel.ReportProblem, 'file:///app/out/renderer/index.html')).toBe(false);
  });

  it('does not open a report for an untrusted origin', () => {
    const ipc = createFakeIpc();
    const reportProblem = vi.fn();
    registerAppIpcHandlers(ipc, { appInfo, reportProblem, devServerOrigin: null });

    expect(() => ipc.invoke(IpcChannel.ReportProblem, 'https://attacker.example')).toThrow(
      /untrusted sender/u,
    );
    expect(reportProblem).not.toHaveBeenCalled();
  });
});
