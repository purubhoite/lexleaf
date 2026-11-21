import { IpcChannel } from '@shared/ipc/channels';
import {
  parseLicenceDocumentId,
  type AppInfo,
  type LicenceDocumentId,
  type LicenceReadResult,
} from '@shared/ipc/contracts';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export type { IpcHandlerRegistrar, IpcInvokeEvent, IpcInvokeListener } from './senderGuard';

export interface AppIpcOptions {
  readonly appInfo: AppInfo;
  /**
   * Opens the prefilled problem report in the reader's browser. The
   * renderer supplies nothing: where it leads is decided here.
   */
  readonly reportProblem: () => void;
  /**
   * Reads one of the licence documents shipped with the build. The id is
   * parsed here, so an unexpected value is refused before anything reads
   * the disk.
   */
  readonly readLicence: (id: LicenceDocumentId) => LicenceReadResult;
  /** Puts the window in or out of full screen. */
  readonly setFullScreen: (on: boolean) => void;
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
  { appInfo, reportProblem, readLicence, setFullScreen, devServerOrigin }: AppIpcOptions,
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

  ipc.handle(
    IpcChannel.ReadLicence,
    guard(IpcChannel.ReadLicence, (raw: unknown): LicenceReadResult => {
      const id = parseLicenceDocumentId(raw);

      if (id === null) {
        return { ok: false, reason: 'not-installed' };
      }

      try {
        return readLicence(id);
      } catch {
        // A notice that cannot be read must not take the settings screen
        // down with it: the panel says so and the reader moves on.
        return { ok: false, reason: 'unreadable' };
      }
    }),
  );

  ipc.handle(
    IpcChannel.SetFullScreen,
    guard(IpcChannel.SetFullScreen, (raw: unknown): boolean => {
      // A boolean and nothing else: anything unexpected leaves the window as it is.
      if (typeof raw !== 'boolean') {
        return false;
      }

      try {
        setFullScreen(raw);

        return true;
      } catch {
        return false;
      }
    }),
  );
};
