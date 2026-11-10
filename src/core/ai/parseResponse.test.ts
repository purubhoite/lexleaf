import { describe, expect, it } from 'vitest';

import { MAX_EXPLANATION_CHARACTERS } from './limits';
import { parseExplanationContent } from './parseResponse';

const parse = (
  content: unknown,
  senseCount = 2,
  stoppedEarly = false,
): ReturnType<typeof parseExplanationContent> =>
  parseExplanationContent(content, { senseCount, stoppedEarly });

describe('a well-formed reply', () => {
  it('becomes an explanation', () => {
    const result = parse('{"explanation":"Here it means electrical charge.","sense_index":0}');

    expect(result).toEqual({
      ok: true,
      value: { text: 'Here it means electrical charge.', senseIndex: 0, truncated: false },
    });
  });

  it('accepts a null sense index', () => {
    const result = parse('{"explanation":"No listed sense fits.","sense_index":null}');

    expect(result.ok && result.value.senseIndex).toBeNull();
  });

  it('accepts a missing sense index', () => {
    const result = parse('{"explanation":"Still an answer."}');

    expect(result.ok && result.value.senseIndex).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parse('\n  {"explanation":"Fine.","sense_index":1}  \n').ok).toBe(true);
  });

  it('reports truncation when the provider stopped early', () => {
    const result = parse('{"explanation":"Cut off here","sense_index":null}', 2, true);

    expect(result.ok && result.value.truncated).toBe(true);
  });
});

describe('a reply that broke the contract', () => {
  it.each([
    ['prose instead of JSON', 'Sure! Here is the explanation: it means money.'],
    ['a JSON array', '[{"explanation":"x"}]'],
    ['a JSON string', '"explanation"'],
    ['null', 'null'],
    ['a missing explanation key', '{"sense_index":0}'],
    ['an explanation of the wrong type', '{"explanation":42,"sense_index":0}'],
    ['truncated JSON', '{"explanation":"half'],
    ['a fenced code block', '```json\n{"explanation":"x"}\n```'],
  ])('rejects %s as malformed', (_label, content) => {
    expect(parse(content)).toEqual({
      ok: false,
      error: { kind: 'unusable-response', reason: 'malformed' },
    });
  });

  it('rejects a non-string body', () => {
    expect(parse({ explanation: 'already parsed' })).toEqual({
      ok: false,
      error: { kind: 'unusable-response', reason: 'malformed' },
    });
  });

  it.each([
    ['an empty string', '{"explanation":"","sense_index":null}'],
    ['whitespace only', '{"explanation":"   \\n\\t ","sense_index":null}'],
    ['control characters only', '{"explanation":"\\u0001\\u0002","sense_index":null}'],
  ])('rejects %s as empty', (_label, content) => {
    expect(parse(content)).toEqual({
      ok: false,
      error: { kind: 'unusable-response', reason: 'empty' },
    });
  });
});

describe('what the parser refuses to trust', () => {
  it('ignores extra keys, including a claimed provider and model', () => {
    const result = parse(
      JSON.stringify({
        explanation: 'It means to rush forward.',
        sense_index: 1,
        provider: 'definitely-not-this-one',
        model: 'claimed-model-9',
        usage: { total_tokens: 99 },
        html: '<b>ignored</b>',
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: { text: 'It means to rush forward.', senseIndex: 1, truncated: false },
    });
  });

  it.each([
    ['out of range', 9],
    ['negative', -1],
    ['fractional', 0.5],
    ['a string', '0'],
  ])('discards a sense index that is %s', (_label, value) => {
    const result = parse(JSON.stringify({ explanation: 'Text.', sense_index: value }));

    expect(result.ok && result.value.senseIndex).toBeNull();
  });

  it('discards every sense index when no senses were offered', () => {
    const result = parse('{"explanation":"Text.","sense_index":0}', 0);

    expect(result.ok && result.value.senseIndex).toBeNull();
  });

  it('strips control characters and bidirectional overrides but keeps newlines', () => {
    const result = parse(
      JSON.stringify({
        explanation: 'Line one.\n\u202eLine\u0007 two.\u0000',
        sense_index: null,
      }),
    );

    expect(result.ok && result.value.text).toBe('Line one.\nLine two.');
  });

  it('keeps markup as literal characters rather than removing or rendering it', () => {
    const result = parse(JSON.stringify({ explanation: '<b>bold</b>', sense_index: null }));

    expect(result.ok && result.value.text).toBe('<b>bold</b>');
  });

  it('truncates an over-long explanation and says so', () => {
    const long = 'a'.repeat(MAX_EXPLANATION_CHARACTERS + 500);
    const result = parse(JSON.stringify({ explanation: long, sense_index: null }));

    expect(result.ok && result.value.text).toHaveLength(MAX_EXPLANATION_CHARACTERS);
    expect(result.ok && result.value.truncated).toBe(true);
  });
});
