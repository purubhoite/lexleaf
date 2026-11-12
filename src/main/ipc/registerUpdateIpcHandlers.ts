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
 * The three update channels.
 *
 * None of them carries an address or a version from the renderer: a check
 * request is one boolean, the setting is one boolean, and "open the
 * download page" has no argument at all — the main process opens the page
 * for the release it found itself, or nothing.
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
    IpcChannel.UpdateOpenDownload,
    guard(IpcChannel.UpdateOpenDownload, (): void => {
      service.openDownload();
    }),
  );
};
