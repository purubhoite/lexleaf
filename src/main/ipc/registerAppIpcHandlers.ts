import { IpcChannel } from '@shared/ipc/channels';
import type { AppInfo } from '@shared/ipc/contracts';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export type { IpcHandlerRegistrar, IpcInvokeEvent, IpcInvokeListener } from './senderGuard';

export interface AppIpcOptions {
  readonly appInfo: AppInfo;
  /**
   * Opens the prefilled problem report in the reader's browser. The
   * renderer supplies nothing: where it leads is decided here.
   */
  readonly reportProblem: () => void;
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
  { appInfo, reportProblem, devServerOrigin }: AppIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(
    IpcChannel.GetAppInfo,
    guard(IpcChannel.GetAppInfo, () => appInfo),
  );

  ipc.handle(
    IpcChannel.ReportProblem,
    guard(IpcChannel.ReportProblem, (): boolean => {
      try {
        reportProblem();

        return true;
      } catch {
        return false;
      }
    }),
  );
};
