import { describe, expect, it } from 'vitest';

import {
  CONTEXT_ENCODING_VERSION,
  canonicalContextEncoding,
  explanationKey,
  sameIdentity,
  type ExplanationIdentity,
} from './identity';

const identity = (overrides: Partial<ExplanationIdentity> = {}): ExplanationIdentity => ({
  wordKey: 'item-1',
  documentId: 'doc-1',
  page: 10,
  contextHash: 'a'.repeat(64),
  promptVersion: 'ctx-explain-1',
  providerId: 'openai-compatible:0123456789abcdef',
  modelId: 'model-a',
  ...overrides,
});

describe('the canonical context encoding', () => {
  it('is the version, the offset, the length and the text, newline separated', () => {
    expect(canonicalContextEncoding('a charge here', 2)).toBe('v1\n2\n13\na charge here');
    expect(CONTEXT_ENCODING_VERSION).toBe('v1');
  });

  it('distinguishes two instances of a word in an identical excerpt', () => {
    const excerpt = 'charge the charge and then charge again';

    expect(canonicalContextEncoding(excerpt, 0)).not.toBe(canonicalContextEncoding(excerpt, 11));
  });

  it('reproduces the same encoding for the same question', () => {
    expect(canonicalContextEncoding('the same text', 4)).toBe(
      canonicalContextEncoding('the same text', 4),
    );
  });

  it('cannot be forged by an excerpt containing a newline', () => {
    // Without the length line, these two could be read the same way.
    const withNewline = canonicalContextEncoding('one\n2\n5\nother', 0);
    const shorter = canonicalContextEncoding('one', 0);

    expect(withNewline).not.toBe(shorter);
    expect(withNewline).toBe('v1\n0\n13\none\n2\n5\nother');
  });

  it('keeps the excerpt verbatim, without trimming or case folding', () => {
    expect(canonicalContextEncoding('  Mixed CASE  ', 2)).toBe('v1\n2\n14\n  Mixed CASE  ');
  });
});

describe('the explanation key', () => {
  it('is stable for the same seven dimensions', () => {
    expect(explanationKey(identity())).toBe(explanationKey(identity()));
    expect(sameIdentity(identity(), identity())).toBe(true);
  });

  it.each([
    ['the word', { wordKey: 'item-2' }],
    ['the document', { documentId: 'doc-2' }],
    ['the page', { page: 84 }],
    ['the context hash', { contextHash: 'b'.repeat(64) }],
    ['the prompt version', { promptVersion: 'ctx-explain-2' }],
    ['the provider', { providerId: 'openai-compatible:fedcba9876543210' }],
    ['the model', { modelId: 'model-b' }],
  ])('changes when %s changes', (_label, overrides: Partial<ExplanationIdentity>) => {
    expect(explanationKey(identity(overrides))).not.toBe(explanationKey(identity()));
    expect(sameIdentity(identity(overrides), identity())).toBe(false);
  });

  it('cannot be impersonated by moving characters between fields', () => {
    expect(explanationKey(identity({ wordKey: 'item', documentId: '1\u001fdoc-1' }))).not.toBe(
      explanationKey(identity()),
    );
  });
});
