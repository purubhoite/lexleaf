import { IpcChannel } from '@shared/ipc/channels';
import {
  UPDATE_STATE_UNKNOWN,
  parseCheckRequest,
  parseSetAutomaticRequest,
  type UpdateIpcState,
} from '@shared/ipc/updateContracts';

import type { UpdateService } from '../update/updateService';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

/**
 * The five update channels.
 *
 * None of them carries an address or a version from the renderer: a check
 * request is one boolean, the setting is one boolean, and "download",
 * "install" and "open the download page" have no argument at all — the
 * main process acts on the release it found itself, or does nothing.
 */

export interface UpdateIpcOptions {
  readonly service: UpdateService;
  readonly onRejected: (message: string) => void;
  readonly devServerOrigin: string | null;
}

export const registerUpdateIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  { service, onRejected, devServerOrigin }: UpdateIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(
    IpcChannel.UpdateCheck,
    guard(IpcChannel.UpdateCheck, async (raw: unknown): Promise<UpdateIpcState> => {
      const request = parseCheckRequest(raw);

      if (request === null) {
        onRejected('a malformed update check request was ignored');

        return UPDATE_STATE_UNKNOWN;
      }

      return service.check(request);
    }),
  );

  ipc.handle(
    IpcChannel.UpdateSetAutomatic,
    guard(IpcChannel.UpdateSetAutomatic, async (raw: unknown): Promise<UpdateIpcState> => {
      const request = parseSetAutomaticRequest(raw);

      if (request === null) {
        onRejected('a malformed update setting was ignored');

        return UPDATE_STATE_UNKNOWN;
      }

      return service.setAutomatic(request.automatic);
    }),
  );

  ipc.handle(
    IpcChannel.UpdateDownload,
    guard(IpcChannel.UpdateDownload, async (): Promise<UpdateIpcState> => service.download()),
  );

  ipc.handle(
    IpcChannel.UpdateInstall,
    guard(IpcChannel.UpdateInstall, async (): Promise<void> => {
      await service.install();
    }),
  );

  ipc.handle(
    IpcChannel.UpdateOpenDownload,
    guard(IpcChannel.UpdateOpenDownload, (): void => {
      service.openDownload();
    }),
  );
};
