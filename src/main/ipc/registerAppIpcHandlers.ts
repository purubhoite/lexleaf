import { IpcChannel } from '@shared/ipc/channels';
import type { AppInfo } from '@shared/ipc/contracts';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export type { IpcHandlerRegistrar, IpcInvokeEvent, IpcInvokeListener } from './senderGuard';

export interface AppIpcOptions {
  readonly appInfo: AppInfo;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
}

/**
 * Registers the handlers the renderer is allowed to invoke.
 *
 * Every handler validates its sender: a frame that is not part of this
 * application must not be able to reach main-process functionality.
 */
export const registerAppIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  { appInfo, devServerOrigin }: AppIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(
    IpcChannel.GetAppInfo,
    guard(IpcChannel.GetAppInfo, () => appInfo),
  );
};
