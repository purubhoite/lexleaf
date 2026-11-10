import { isApplicationUrl } from '../security/navigationPolicy';

/** Minimal structural view of the Electron `ipcMain` API used here. */
export interface IpcInvokeEvent {
  readonly senderFrame: { readonly url: string } | null;
}

export type IpcInvokeListener = (event: IpcInvokeEvent, ...args: unknown[]) => unknown;

export interface IpcHandlerRegistrar {
  handle(channel: string, listener: IpcInvokeListener): void;
}

/**
 * Wraps a handler so that it only ever runs for this application's own frames.
 *
 * Every channel is guarded the same way, in one place: a frame that is not
 * part of this application must not be able to reach main-process
 * functionality, and a channel added later must not be able to forget the
 * check (ADR-011).
 */
export const createSenderGuard =
  (devServerOrigin: string | null) =>
  (channel: string, handler: (...args: unknown[]) => unknown): IpcInvokeListener =>
  (event, ...args) => {
    const senderUrl = event.senderFrame?.url ?? '';

    if (!isApplicationUrl(senderUrl, devServerOrigin)) {
      throw new Error(`Blocked ${channel} request from an untrusted sender.`);
    }

    return handler(...args);
  };
