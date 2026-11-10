import { describe, expect, it } from 'vitest';

import { buildExplanationRequest } from '@core/ai/prompt';

import { createNotConfiguredExplainer } from './notConfigured';

const request = buildExplanationRequest({
  display: 'charge',
  normalized: 'charge',
  headword: 'charge',
  resolvedBy: 'exact',
  lookupStatus: 'found',
  senses: [],
  context: 'The capacitor holds a charge.',
  contextWordStart: 22,
});

describe('the default provider', () => {
  it('answers that nothing is configured', async () => {
    const result = await createNotConfiguredExplainer().explain(
      request,
      new AbortController().signal,
    );

    expect(result).toEqual({ ok: false, error: { kind: 'not-configured' } });
  });

  it('describes no destination and nothing remote', () => {
    expect(createNotConfiguredExplainer().describe()).toEqual({
      provider: 'none',
      model: 'none',
      remote: false,
    });
  });

  it('performs no I/O: it does not touch fetch', async () => {
    const original = globalThis.fetch;
    let called = false;

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: () => {
        called = true;

        throw new Error('the unconfigured provider must not reach the network');
      },
    });

    try {
      await createNotConfiguredExplainer().explain(request, new AbortController().signal);
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: original });
    }

    expect(called).toBe(false);
  });
});
