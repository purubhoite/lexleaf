import { describe, expect, it } from 'vitest';

import { parseAppInfo } from './contracts';

const validAppInfo = {
  name: 'Intelligent PDF Reader',
  version: '0.1.0',
  electronVersion: '41.10.7',
  chromeVersion: '142.0.0.0',
};

describe('parseAppInfo', () => {
  it('accepts a well-formed payload and returns a normalised object', () => {
    expect(parseAppInfo(validAppInfo)).toEqual(validAppInfo);
  });

  it('ignores unexpected additional properties', () => {
    const result = parseAppInfo({ ...validAppInfo, injected: 'value' });

    expect(result).toEqual(validAppInfo);
    expect(result).not.toHaveProperty('injected');
  });

  it.each([
    ['null', null],
    ['a string', 'Intelligent PDF Reader'],
    ['an array', []],
    ['an empty object', {}],
  ])('rejects %s', (_label, value) => {
    expect(parseAppInfo(value)).toBeNull();
  });

  it.each(['name', 'version', 'electronVersion', 'chromeVersion'])(
    'rejects a payload with a missing %s field',
    (field) => {
      const payload: Record<string, unknown> = { ...validAppInfo };
      delete payload[field];

      expect(parseAppInfo(payload)).toBeNull();
    },
  );

  it('rejects empty string fields', () => {
    expect(parseAppInfo({ ...validAppInfo, version: '' })).toBeNull();
  });
});
