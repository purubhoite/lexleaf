import { describe, expect, it } from 'vitest';

import { MAX_RESPONSE_BYTES } from '@core/ai/limits';
import { buildExplanationRequest } from '@core/ai/prompt';
import type { ContextExplanationRequest } from '@core/ai/types';

import { CANCELLED_ABORT_REASON, TIMEOUT_ABORT_REASON } from '../abort';
import { loadAiConfiguration, type AiConfiguration } from '../configuration';

import { createOpenAiCompatibleExplainer, type FetchLike } from './openAiCompatible';

/**
 * Adapter behaviour, against an injected `fetch`.
 *
 * No socket is opened anywhere in this file, and no real provider is
 * contacted. The three properties the design depends on — a signal is
 * passed, redirects are refused, the byte cap is enforced while reading —
 * are asserted here against the fake, and were separately measured against
 * Electron's `net.fetch` in the investigation (section 13.4).
 */

const configurationFor = (
  endpoint: string,
  key: string | null = 'sk-secret-value',
): AiConfiguration => {
  const configuration = loadAiConfiguration({
    env: {
      INTELLIGENT_PDF_READER_AI_ENDPOINT: endpoint,
      INTELLIGENT_PDF_READER_AI_MODEL: 'small-model',
      ...(key === null ? {} : { INTELLIGENT_PDF_READER_AI_KEY: key }),
    },
    readConfigurationFile: () => null,
  });

  if (configuration === null) {
    throw new Error('the test configuration was rejected');
  }

  return configuration;
};

const request: ContextExplanationRequest = buildExplanationRequest({
  display: 'charge',
  normalized: 'charge',
  headword: 'charge',
  resolvedBy: 'exact',
  lookupStatus: 'found',
  senses: [
    { partOfSpeech: 'noun', definition: 'a quantity of electricity' },
    { partOfSpeech: 'verb', definition: 'ask an amount as a price' },
  ],
  context: 'The capacitor holds a charge for several minutes.',
  contextWordStart: 22,
});

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const explainerWith = (
  fetchImpl: FetchLike,
  endpoint = 'https://api.example.com/v1',
  key: string | null = 'sk-secret-value',
): ReturnType<typeof createOpenAiCompatibleExplainer> =>
  createOpenAiCompatibleExplainer({
    configuration: configurationFor(endpoint, key),
    fetchImpl,
    nonce: () => 'abcd1234',
  });

const recording = (
  reply: () => Promise<Response>,
): { readonly calls: Call[]; readonly fetchImpl: FetchLike } => {
  const calls: Call[] = [];

  return {
    calls,
    fetchImpl: (url, init): Promise<Response> => {
      calls.push({ url, init });

      return reply();
    },
  };
};

const answer = (content: string, finishReason = 'stop'): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );

const explanation = JSON.stringify({ explanation: 'Here it is electrical.', sense_index: 0 });

describe('the request the adapter sends', () => {
  it('posts to the completions path of the configured endpoint', async () => {
    const { calls, fetchImpl } = recording(() => Promise.resolve(answer(explanation)));

    await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('refuses redirects and passes the signal', async () => {
    const { calls, fetchImpl } = recording(() => Promise.resolve(answer(explanation)));
    const controller = new AbortController();

    await explainerWith(fetchImpl).explain(request, controller.signal);

    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it('sends the assembled prompt and the configured model, and nothing else', async () => {
    const { calls, fetchImpl } = recording(() => Promise.resolve(answer(explanation)));

    await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    const body = JSON.parse((calls[0]?.init.body ?? '{}') as string) as Record<string, unknown>;

    expect(body['model']).toBe('small-model');
    expect(body['stream']).toBe(false);
    expect(JSON.stringify(body)).toContain('<<<EXCERPT abcd1234>>>');
    expect(JSON.stringify(body)).not.toContain('sk-secret-value');
  });

  it('allows a loopback endpoint over plain http', async () => {
    const { calls, fetchImpl } = recording(() => Promise.resolve(answer(explanation)));

    await explainerWith(fetchImpl, 'http://127.0.0.1:11434/v1', null).explain(
      request,
      new AbortController().signal,
    );

    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('never requests anything when the endpoint is not permitted', async () => {
    const { calls, fetchImpl } = recording(() => Promise.resolve(answer(explanation)));
    const explainer = createOpenAiCompatibleExplainer({
      configuration: {
        ...configurationFor('https://api.example.com/v1'),
        endpoint: 'http://remote.example/v1',
      },
      fetchImpl,
      nonce: () => 'abcd1234',
    });

    const result = await explainer.explain(request, new AbortController().signal);

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, error: { kind: 'not-configured' } });
  });
});

describe('what the adapter makes of a reply', () => {
  it('turns a valid body into an explanation', async () => {
    const { fetchImpl } = recording(() => Promise.resolve(answer(explanation)));

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({
      ok: true,
      value: { text: 'Here it is electrical.', senseIndex: 0, truncated: false },
    });
  });

  it('marks an answer the provider cut short', async () => {
    const { fetchImpl } = recording(() => Promise.resolve(answer(explanation, 'length')));

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result.ok && result.value.truncated).toBe(true);
  });

  it('reports a content filter as a refusal', async () => {
    const { fetchImpl } = recording(() => Promise.resolve(answer(explanation, 'content_filter')));

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({ ok: false, error: { kind: 'rejected', reason: 'refused' } });
  });

  it.each([
    ['an envelope without choices', '{"id":"x"}'],
    ['a choice without a message', '{"choices":[{}]}'],
    ['prose', 'not json at all'],
  ])('rejects %s as malformed', async (_label, body) => {
    const { fetchImpl } = recording(() => Promise.resolve(new Response(body, { status: 200 })));

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unusable-response', reason: 'malformed' },
    });
  });

  it.each([
    [401, { kind: 'rejected', reason: 'auth' }],
    [403, { kind: 'rejected', reason: 'auth' }],
    [429, { kind: 'rejected', reason: 'rate-limited' }],
    [402, { kind: 'rejected', reason: 'quota' }],
    [400, { kind: 'provider-error' }],
    [500, { kind: 'provider-error' }],
    [503, { kind: 'provider-error' }],
  ])('maps status %i to a typed failure', async (status, expected) => {
    const { fetchImpl } = recording(() =>
      Promise.resolve(
        new Response('{"error":{"message":"sk-secret-value leaked here"}}', { status }),
      ),
    );

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({ ok: false, error: expected });
    expect(JSON.stringify(result)).not.toContain('sk-secret-value');
  });

  it('treats a network failure as being offline', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('fetch failed'));

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({ ok: false, error: { kind: 'offline' } });
  });

  it('treats a refused redirect as a provider error', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new TypeError("Attempted to redirect, but redirect policy was 'error'"));

    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({ ok: false, error: { kind: 'provider-error' } });
  });
});

describe('abort and size', () => {
  const aborting =
    (reason: string): FetchLike =>
    (_url, init) => {
      const signal = init.signal as AbortSignal | undefined;

      signal?.throwIfAborted();

      return Promise.reject(new DOMException(`aborted: ${reason}`, 'AbortError'));
    };

  it('reports a cancellation as cancelled, not as a failure', async () => {
    const controller = new AbortController();

    controller.abort(CANCELLED_ABORT_REASON);

    const result = await explainerWith(aborting(CANCELLED_ABORT_REASON)).explain(
      request,
      controller.signal,
    );

    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
  });

  it('reports a timeout as a timeout', async () => {
    const controller = new AbortController();

    controller.abort(TIMEOUT_ABORT_REASON);

    const result = await explainerWith(aborting(TIMEOUT_ABORT_REASON)).explain(
      request,
      controller.signal,
    );

    expect(result).toEqual({ ok: false, error: { kind: 'timeout' } });
  });

  it('stops reading an endless body at the byte cap', async () => {
    const chunk = new Uint8Array(8192).fill(97);
    let produced = 0;
    let cancelled = false;

    const endless = new ReadableStream<Uint8Array>({
      pull: (controller): void => {
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel: (): void => {
        cancelled = true;
      },
    });

    const { fetchImpl } = recording(() => Promise.resolve(new Response(endless, { status: 200 })));
    const result = await explainerWith(fetchImpl).explain(request, new AbortController().signal);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unusable-response', reason: 'oversized' },
    });
    expect(cancelled).toBe(true);
    // Bounded: the reader stopped shortly after the cap rather than
    // consuming an unbounded amount first.
    expect(produced).toBeLessThan(MAX_RESPONSE_BYTES * 3);
  });
});

describe('what the adapter discloses', () => {
  it('names the destination and the model, never the key', () => {
    const { fetchImpl } = recording(() => Promise.resolve(answer(explanation)));

    expect(explainerWith(fetchImpl).describe()).toEqual({
      provider: 'api.example.com',
      model: 'small-model',
      remote: true,
    });
  });

  it('keeps no credential in any diagnostic', async () => {
    const messages: string[] = [];
    const explainer = createOpenAiCompatibleExplainer({
      configuration: configurationFor('https://api.example.com/v1'),
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 500 })),
      nonce: () => 'abcd1234',
      onDiagnostic: (message) => messages.push(message),
    });

    await explainer.explain(request, new AbortController().signal);

    expect(messages.join(' ')).toContain('500');
    expect(messages.join(' ')).not.toContain('sk-secret-value');
    expect(messages.join(' ')).not.toContain('api.example.com');
  });
});
