import type { DictionaryQuery, DictionaryResult } from '@core/dictionary/types';
import { IpcChannel } from '@shared/ipc/channels';
import { parseDictionaryQuery } from '@shared/ipc/contracts';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

/**
 * The dictionary's single IPC channel.
 *
 * One operation, one direction, one shape: a word in, a result out. The
 * renderer cannot name a file, a provider, a dictionary or a location, so
 * there is no path for it to influence what is read from disk (ADR-011).
 *
 * A malformed query is answered with `unavailable`, not with an exception:
 * the reader is in the middle of reading, and a rejected message must not
 * become an unhandled rejection in the renderer.
 */

export interface DictionaryIpcOptions {
  readonly lookUp: (query: DictionaryQuery) => DictionaryResult;
  /** Reported when the renderer sends something malformed. */
  readonly onRejected: (message: string) => void;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
}

export const registerDictionaryIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  { lookUp, onRejected, devServerOrigin }: DictionaryIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(
    IpcChannel.LookUpWord,
    guard(IpcChannel.LookUpWord, (raw: unknown): DictionaryResult => {
      const query = parseDictionaryQuery(raw);

      if (query === null) {
        onRejected('a malformed dictionary query was ignored');

        return { status: 'unavailable', reason: 'unreadable' };
      }

      return lookUp(query);
    }),
  );
};
