import { IpcChannel } from '@shared/ipc/channels';
import {
  parseExplainRequest,
  parseRequestId,
  parseStoredExplanationQuery,
  type AiIpcResult,
  type AiStatusReply,
  type ExplanationIpcView,
} from '@shared/ipc/aiContracts';
import { normalizeWord } from '@core/word/normalizeWord';

import type { ExplanationService, ExplanationWord } from '../ai/explanationService';

import { createSenderGuard, type IpcHandlerRegistrar, type IpcInvokeListener } from './senderGuard';

/**
 * The four explanation channels, and nothing else.
 *
 * There is deliberately no channel that takes a URL, a prompt, a model
 * name or a credential, and no channel that forwards an arbitrary request
 * anywhere. The renderer can ask for *this word, in this passage, on this
 * page* and can abandon the attempt. That is the entire surface, which is
 * why a compromised renderer gains no new reach: it already had the page
 * text it is quoting.
 *
 * As in the vocabulary handlers, identity is recomputed here with the same
 * normaliser the dictionary uses, so a renderer cannot have one word
 * explained under another word's identity or cause a row to be written
 * against a spelling the store never uses.
 */

export interface AiIpcOptions {
  readonly service: ExplanationService;
  /** Reported when the renderer sends something malformed. */
  readonly onRejected: (message: string) => void;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
  readonly ensureReady?: () => Promise<unknown>;
  readonly enterOperation?: () => (() => void) | null;
  readonly enabled?: boolean;
}

const normalizeForm = (word: ExplanationWord): ExplanationWord | null => {
  const normalized = normalizeWord(word.normalized.length > 0 ? word.normalized : word.raw);

  return normalized.length === 0 ? null : { ...word, normalized };
};

export const registerAiIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  {
    service,
    onRejected,
    devServerOrigin,
    ensureReady = async (): Promise<void> => {},
    enterOperation = () => (): void => {},
    enabled = true,
  }: AiIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);
  type Handler = (...args: unknown[]) => unknown;
  const readyGuard = (channel: string, handler: Handler): IpcInvokeListener =>
    guard(channel, async (...args: unknown[]): Promise<unknown> => {
      if (!enabled) return { ok: false, error: { kind: 'provider-error' } };
      const release = enterOperation();
      if (release === null) return { ok: false, error: { kind: 'provider-error' } };
      try {
        await ensureReady();
        return await handler(...args);
      } catch {
        return { ok: false, error: { kind: 'provider-error' } };
      } finally {
        release();
      }
    });

  ipc.handle(
    IpcChannel.AiStatus,
    readyGuard(IpcChannel.AiStatus, (): AiStatusReply => service.status()),
  );

  ipc.handle(
    IpcChannel.AiExplanationFor,
    readyGuard(IpcChannel.AiExplanationFor, (raw: unknown): ExplanationIpcView | null => {
      const query = parseStoredExplanationQuery(raw);

      if (query === null) {
        onRejected('a malformed stored explanation request was ignored');

        return null;
      }

      const word = normalizeForm(query.word);

      if (word === null) {
        return null;
      }

      return service.stored({ ...query, word });
    }),
  );

  ipc.handle(
    IpcChannel.AiExplain,
    readyGuard(
      IpcChannel.AiExplain,
      async (raw: unknown): Promise<AiIpcResult<ExplanationIpcView>> => {
        const request = parseExplainRequest(raw);

        if (request === null) {
          onRejected('a malformed explanation request was ignored');

          // The renderer gets a failure it already knows how to show,
          // rather than a reason that would describe the check it failed.
          return { ok: false, error: { kind: 'provider-error' } };
        }

        const word = normalizeForm(request.word);

        if (word === null) {
          onRejected('an explanation request for an empty word was ignored');

          return { ok: false, error: { kind: 'provider-error' } };
        }

        return service.explain({ ...request, word });
      },
    ),
  );

  ipc.handle(
    IpcChannel.AiCancel,
    readyGuard(IpcChannel.AiCancel, (raw: unknown): null => {
      const requestId = parseRequestId(raw);

      if (requestId === null) {
        onRejected('a malformed cancellation was ignored');

        return null;
      }

      service.cancel(requestId);

      return null;
    }),
  );
};
