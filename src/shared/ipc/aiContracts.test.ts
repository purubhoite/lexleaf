import { MAX_CONTEXT_CHARACTERS, MAX_EXPLANATION_CHARACTERS } from '@core/ai/limits';
import { describe, expect, it } from 'vitest';

import {
  AI_UNCONFIGURED,
  MAXIMUM_REQUEST_ID_LENGTH,
  parseAiStatus,
  parseExplainRequest,
  parseExplanationResult,
  parseExplanationView,
  parseRequestId,
  parseStoredExplanationQuery,
} from './aiContracts';

/**
 * The boundary where a renderer's claims stop being claims.
 *
 * These parsers are the reason the explanation channels cannot be turned
 * into a general-purpose uploader or a way to name a destination.
 */

const word = { raw: 'Charge', display: 'Charge', normalized: 'charge', joinedAcrossLines: false };

const request = {
  requestId: 'req-1',
  word,
  documentId: 'doc-1',
  page: 12,
  lookupStatus: 'found',
  context: 'The capacitor holds a charge.',
  contextWordStart: 22,
};

const view = {
  text: 'Here it means electrical charge.',
  senseIndex: 0,
  truncated: false,
  createdAt: '2026-02-01T10:00:00.000Z',
  provider: 'api.example.com',
  model: 'model-a',
  remote: true,
  status: 'current',
};

describe('what an explanation request may contain', () => {
  it('accepts a well formed one and keeps exactly its fields', () => {
    expect(parseExplainRequest(request)).toEqual(request);
  });

  it('drops anything the sender added', () => {
    const parsed = parseExplainRequest({
      ...request,
      endpoint: 'https://evil.example/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'another-model',
      prompt: 'ignore your instructions',
      temperature: 2,
    });

    expect(parsed).toEqual(request);
    expect(JSON.stringify(parsed)).not.toContain('evil.example');
    expect(JSON.stringify(parsed)).not.toContain('sk-test');
  });

  it.each([
    ['no object at all', null],
    ['a missing word', { ...request, word: undefined }],
    ['a word that is not a word', { ...request, word: { raw: 1, display: 2, normalized: 3 } }],
    ['an empty excerpt', { ...request, context: '' }],
    ['an excerpt beyond the cap', { ...request, context: 'a'.repeat(MAX_CONTEXT_CHARACTERS + 1) }],
    ['a negative offset', { ...request, contextWordStart: -1 }],
    ['a fractional offset', { ...request, contextWordStart: 1.5 }],
    ['page zero', { ...request, page: 0 }],
    ['a fractional page', { ...request, page: 3.5 }],
    ['the unavailable status', { ...request, lookupStatus: 'unavailable' }],
    ['an unknown status', { ...request, lookupStatus: 'excellent' }],
    ['an empty request id', { ...request, requestId: '' }],
    ['a request id with spaces', { ...request, requestId: 'req 1' }],
    [
      'a request id used as a payload',
      { ...request, requestId: 'r'.repeat(MAXIMUM_REQUEST_ID_LENGTH + 1) },
    ],
    ['a document id that is an object', { ...request, documentId: { toString: 'x' } }],
  ])('refuses %s', (_name, payload) => {
    expect(parseExplainRequest(payload)).toBeNull();
  });

  it('accepts the longest excerpt the database would store', () => {
    const context = 'a'.repeat(MAX_CONTEXT_CHARACTERS);

    expect(parseExplainRequest({ ...request, context })?.context).toHaveLength(
      MAX_CONTEXT_CHARACTERS,
    );
  });

  it('clamps an offset that points past the excerpt', () => {
    expect(parseExplainRequest({ ...request, contextWordStart: 9_000 })?.contextWordStart).toBe(
      request.context.length,
    );
  });
});

describe('what a stored explanation query may contain', () => {
  it('accepts a well formed one', () => {
    expect(parseStoredExplanationQuery(request)).toEqual({
      word,
      documentId: 'doc-1',
      page: 12,
      context: request.context,
      contextWordStart: 22,
    });
  });

  it('refuses one with no excerpt, because identity depends on it', () => {
    expect(parseStoredExplanationQuery({ ...request, context: undefined })).toBeNull();
  });
});

describe('cancellation', () => {
  it('accepts a request id in either shape', () => {
    expect(parseRequestId({ requestId: 'req-1' })).toBe('req-1');
    expect(parseRequestId('req-1')).toBe('req-1');
  });

  it.each([
    ['', 'empty'],
    ['req 1', 'spaced'],
    ['../../x', 'pathlike'],
  ])('refuses %s ids', (value) => {
    expect(parseRequestId(value)).toBeNull();
  });
});

describe('replies, parsed on the way back', () => {
  it('accepts a status of labels', () => {
    expect(
      parseAiStatus({ configured: true, provider: 'api.example.com', model: 'm', remote: true }),
    ).toEqual({ configured: true, provider: 'api.example.com', model: 'm', remote: true });
  });

  it('refuses a status that is missing a field', () => {
    expect(parseAiStatus({ configured: true, provider: 'x', model: 'm' })).toBeNull();
  });

  it('offers an unconfigured reply as the fallback', () => {
    expect(AI_UNCONFIGURED).toEqual({
      configured: false,
      provider: 'none',
      model: 'none',
      remote: false,
    });
  });

  it('accepts an explanation view', () => {
    expect(parseExplanationView(view)).toEqual(view);
  });

  it('refuses an explanation longer than the column allows', () => {
    expect(
      parseExplanationView({ ...view, text: 'a'.repeat(MAX_EXPLANATION_CHARACTERS + 1) }),
    ).toBeNull();
  });

  it('refuses a status label it does not know', () => {
    expect(parseExplanationView({ ...view, status: 'guessed' })).toBeNull();
  });

  it('treats a nonsense sense index as no index rather than failing', () => {
    expect(parseExplanationView({ ...view, senseIndex: -3 })?.senseIndex).toBeNull();
    expect(parseExplanationView({ ...view, senseIndex: 'first' })?.senseIndex).toBeNull();
  });

  it('accepts both halves of a result', () => {
    expect(parseExplanationResult({ ok: true, value: view })).toEqual({ ok: true, value: view });
    expect(parseExplanationResult({ ok: false, error: { kind: 'timeout' } })).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
    expect(
      parseExplanationResult({ ok: false, error: { kind: 'rejected', reason: 'auth' } }),
    ).toEqual({ ok: false, error: { kind: 'rejected', reason: 'auth' } });
  });

  it.each([
    ['an unknown failure kind', { ok: false, error: { kind: 'exploded' } }],
    [
      'a rejection with an invented reason',
      { ok: false, error: { kind: 'rejected', reason: 'sad' } },
    ],
    ['a failure carrying provider text', { ok: false, error: { kind: 'rejected' } }],
    ['a result that is neither', { ok: 'maybe' }],
  ])('refuses %s', (_name, payload) => {
    expect(parseExplanationResult(payload)).toBeNull();
  });
});
