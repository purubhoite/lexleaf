import type { Preferences } from '@core/persistence/preferences';
import { IpcChannel } from '@shared/ipc/channels';
import {
  parseDocumentId,
  parsePreferencesUpdate,
  parseReadingPositionUpdate,
  type ReaderStateSnapshot,
  type ReadingPositionUpdate,
  type StateWriteHealth,
} from '@shared/ipc/contracts';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export interface StateIpcOptions {
  readonly snapshot: () => Promise<ReaderStateSnapshot>;
  readonly savePosition: (update: ReadingPositionUpdate) => Promise<StateWriteHealth>;
  readonly forgetDocument: (documentId: string) => Promise<StateWriteHealth>;
  /** Stores the four settings and applies the ones the main process owns. */
  readonly savePreferences: (preferences: Preferences) => Promise<StateWriteHealth>;
  /** Reported when the renderer sends something malformed. */
  readonly onRejected: (message: string) => void;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
}

/**
 * Registers the reading-state channels.
 *
 * Every inbound channel validates its argument before anything reaches the
 * store: the renderer is untrusted input to the main process, and these are
 * the messages that cause a write to disk.
 *
 * Saving never throws back at the renderer. Losing a reading position must
 * not surface as a failed operation in the middle of reading (ADR-016).
 *
 * It does, however, *answer*. Each of the three channels that cause a write
 * replies with the health of the store's last write (M7.2, ADR-034). A
 * rejected payload answers `ok`, because nothing was written and nothing is
 * wrong with the disk; the malformed message is a renderer fault and goes to
 * the log, as it always did.
 */
export const registerStateIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  {
    snapshot,
    savePosition,
    forgetDocument,
    savePreferences,
    onRejected,
    devServerOrigin,
  }: StateIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(IpcChannel.GetReaderState, guard(IpcChannel.GetReaderState, snapshot));

  ipc.handle(
    IpcChannel.SaveReadingPosition,
    guard(IpcChannel.SaveReadingPosition, async (raw: unknown): Promise<StateWriteHealth> => {
      const update = parseReadingPositionUpdate(raw);

      if (update === null) {
        onRejected('a malformed reading position was ignored');
        return 'ok';
      }

      return savePosition(update);
    }),
  );

  /*
   * The settings channel (ADR-031). Guarded like every other one, and
   * narrow by construction: the payload is parsed into exactly the four
   * enumerated preferences, so a key the application does not know about
   * is dropped at this line rather than stored, and an unknown value
   * becomes that field's default. Nothing here can name a file, a URL or
   * a credential, because no field of this shape can hold one.
   */
  ipc.handle(
    IpcChannel.SavePreferences,
    guard(IpcChannel.SavePreferences, async (raw: unknown): Promise<StateWriteHealth> => {
      const preferences = parsePreferencesUpdate(raw);

      if (preferences === null) {
        onRejected('a malformed preferences payload was ignored');
        return 'ok';
      }

      return savePreferences(preferences);
    }),
  );

  ipc.handle(
    IpcChannel.ForgetDocument,
    guard(IpcChannel.ForgetDocument, async (raw: unknown): Promise<StateWriteHealth> => {
      const documentId = parseDocumentId(raw);

      if (documentId === null) {
        onRejected('a malformed document id was ignored');
        return 'ok';
      }

      return forgetDocument(documentId);
    }),
  );
};
