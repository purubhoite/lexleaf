import { ok } from '@core/result';
import type { AiIpcResult } from '@shared/ipc/aiContracts';
import { MAX_CONTEXT_CHARACTERS } from '@core/ai/limits';
import { IpcChannel } from '@shared/ipc/channels';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExplainCommand, ExplanationService, ExplanationView } from '../ai/explanationService';

import { registerAiIpcHandlers } from './registerAiIpcHandlers';
import type { IpcInvokeListener } from './senderGuard';

/** The guard, the parser, the service, the typed reply — in that order. */

const TRUSTED = { senderFrame: { url: 'file:///app/renderer/index.html' } };
const UNTRUSTED = { senderFrame: { url: 'https://example.com/' } };

const explanation: ExplanationView = {
  text: 'Here it means a quantity of electricity.',
  senseIndex: 0,
  truncated: false,
  createdAt: '2026-02-01T10:00:00.000Z',
  provider: 'api.example.com',
  model: 'model-a',
  remote: true,
  status: 'current',
};

const message = {
  requestId: 'req-1',
  word: { raw: 'Charge', display: 'Charge', normalized: 'Charge', joinedAcrossLines: false },
  documentId: 'doc-1',
  page: 12,
  lookupStatus: 'found',
  context: 'The capacitor holds a charge.',
  contextWordStart: 22,
};

const service = (overrides: Partial<ExplanationService> = {}): ExplanationService => ({
  status: () => ({ configured: true, provider: 'api.example.com', model: 'model-a', remote: true }),
  stored: () => null,
  explain: () => Promise.resolve(ok(explanation)),
  cancel: (): void => {},
  promote: (): void => {},
  close: (): void => {},
  ...overrides,
});

interface Harness {
  readonly handlers: Map<string, IpcInvokeListener>;
  readonly rejections: string[];
}

let harness: Harness;

const register = (overrides: Partial<ExplanationService> = {}): void => {
  registerAiIpcHandlers(
    {
      handle: (channel, listener): void => {
        harness.handlers.set(channel, listener);
      },
    },
    {
      service: service(overrides),
      onRejected: (reason): void => {
        harness.rejections.push(reason);
      },
      devServerOrigin: null,
    },
  );
};

const invoke = (channel: string, payload: unknown, event = TRUSTED): Promise<unknown> =>
  Promise.resolve(harness.handlers.get(channel)?.(event, payload));

beforeEach(() => {
  harness = { handlers: new Map(), rejections: [] };
});

describe('the channels that exist', () => {
  it('registers exactly the four AI channels', () => {
    register();

    expect([...harness.handlers.keys()].sort()).toEqual(
      [
        IpcChannel.AiCancel,
        IpcChannel.AiExplain,
        IpcChannel.AiExplanationFor,
        IpcChannel.AiStatus,
      ].sort(),
    );
  });

  it('has no channel that could carry an endpoint or a credential', () => {
    register();

    for (const channel of harness.handlers.keys()) {
      expect(channel).not.toMatch(/url|endpoint|fetch|proxy|key|token|prompt|model/u);
    }
  });
});

describe('the sender guard', () => {
  it('refuses every channel from an untrusted frame', () => {
    const explain = vi.fn(() => Promise.resolve(ok(explanation)));
    const cancel = vi.fn();

    register({ explain, cancel });

    for (const channel of harness.handlers.keys()) {
      expect(() => harness.handlers.get(channel)?.(UNTRUSTED, message)).toThrow(
        /untrusted sender/u,
      );
    }

    expect(explain).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('ai:status', () => {
  it('reports labels only', async () => {
    register();

    const reply = await invoke(IpcChannel.AiStatus, undefined);

    expect(reply).toEqual({
      configured: true,
      provider: 'api.example.com',
      model: 'model-a',
      remote: true,
    });
    expect(JSON.stringify(reply)).not.toMatch(/https?:|key|token/u);
  });
});

describe('ai:explain', () => {
  it('passes a well formed request to the service', async () => {
    const explain = vi.fn(() => Promise.resolve(ok(explanation)));

    register({ explain });

    expect(await invoke(IpcChannel.AiExplain, message)).toEqual({ ok: true, value: explanation });
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('recomputes the word identity instead of trusting the sender', async () => {
    const seen: ExplainCommand[] = [];
    const explain = (command: ExplainCommand): Promise<AiIpcResult<ExplanationView>> => {
      seen.push(command);

      return Promise.resolve(ok(explanation));
    };

    register({ explain });

    await invoke(IpcChannel.AiExplain, {
      ...message,
      word: { ...message.word, normalized: '  CHARGE ' },
    });

    expect(seen[0]?.word.normalized).toBe('charge');
  });

  it.each([
    ['nothing at all', undefined],
    ['a request with no word', { ...message, word: undefined }],
    ['a request with no excerpt', { ...message, context: '' }],
    ['a page that is not a page', { ...message, page: 0 }],
    ['a lookup status the popup cannot have', { ...message, lookupStatus: 'unavailable' }],
    ['a request id that is not one', { ...message, requestId: 'req 1; drop table' }],
    [
      'an excerpt longer than a passage',
      { ...message, context: 'a'.repeat(MAX_CONTEXT_CHARACTERS + 1) },
    ],
    [
      'a word that normalises away',
      { ...message, word: { ...message.word, raw: '!!', normalized: '!!' } },
    ],
  ])('refuses %s without calling the service', async (_name, payload) => {
    const explain = vi.fn(() => Promise.resolve(ok(explanation)));

    register({ explain });

    expect(await invoke(IpcChannel.AiExplain, payload)).toEqual({
      ok: false,
      error: { kind: 'provider-error' },
    });
    expect(explain).not.toHaveBeenCalled();
    expect(harness.rejections).toHaveLength(1);
  });

  it('says nothing about which check a bad request failed', async () => {
    register();

    const reply = await invoke(IpcChannel.AiExplain, { ...message, page: -4 });

    expect(JSON.stringify(reply)).not.toMatch(/page|parse|invalid/u);
  });
});

describe('ai:explanation-for', () => {
  it('returns what is already known', async () => {
    const stored = vi.fn(() => explanation);

    register({ stored });

    expect(await invoke(IpcChannel.AiExplanationFor, message)).toEqual(explanation);
  });

  it('answers null rather than failing when nothing is known', async () => {
    register();

    expect(await invoke(IpcChannel.AiExplanationFor, message)).toBeNull();
  });

  it('never reaches the service with a malformed query', async () => {
    const stored = vi.fn(() => explanation);

    register({ stored });

    expect(await invoke(IpcChannel.AiExplanationFor, { documentId: 'doc-1' })).toBeNull();
    expect(stored).not.toHaveBeenCalled();
  });
});

describe('ai:cancel', () => {
  it('cancels by request id', async () => {
    const cancel = vi.fn();

    register({ cancel });

    expect(await invoke(IpcChannel.AiCancel, { requestId: 'req-1' })).toBeNull();
    expect(cancel).toHaveBeenCalledWith('req-1');
  });

  it('ignores a cancellation that names nothing usable', async () => {
    const cancel = vi.fn();

    register({ cancel });

    await invoke(IpcChannel.AiCancel, { requestId: '' });

    expect(cancel).not.toHaveBeenCalled();
    expect(harness.rejections).toEqual(['a malformed cancellation was ignored']);
  });
});
