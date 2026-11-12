import { describe, expect, it } from 'vitest';

import { parseCheckRequest, parseSetAutomaticRequest, parseUpdateState } from './updateContracts';

describe('parseUpdateState', () => {
  it('accepts each outcome the main process can report', () => {
    for (const outcome of [
      { status: 'idle' },
      { status: 'up-to-date' },
      { status: 'failed' },
      { status: 'available', version: '0.2.0' },
    ]) {
      expect(parseUpdateState({ automatic: true, outcome })).toStrictEqual({
        automatic: true,
        outcome,
      });
    }
  });

  it('normalises the version and drops everything else', () => {
    expect(
      parseUpdateState({
        automatic: false,
        outcome: { status: 'available', version: 'v0.2.0', address: 'https://example.com/' },
        extra: 1,
      }),
    ).toStrictEqual({ automatic: false, outcome: { status: 'available', version: '0.2.0' } });
  });

  it('refuses a version that is not a version', () => {
    for (const version of [undefined, '', 'latest', '<b>1.0.0</b>', '1.0.0-beta']) {
      expect(
        parseUpdateState({ automatic: true, outcome: { status: 'available', version } }),
      ).toBeNull();
    }
  });

  it('refuses a malformed reply', () => {
    for (const value of [
      null,
      'ok',
      {},
      { automatic: 'yes', outcome: { status: 'idle' } },
      { automatic: true },
      { automatic: true, outcome: { status: 'downloading' } },
    ]) {
      expect(parseUpdateState(value)).toBeNull();
    }
  });
});

describe('the two requests', () => {
  it('accept exactly one boolean each', () => {
    expect(parseCheckRequest({ manual: true })).toStrictEqual({ manual: true });
    expect(parseCheckRequest({ manual: false, other: 1 })).toStrictEqual({ manual: false });
    expect(parseSetAutomaticRequest({ automatic: false })).toStrictEqual({ automatic: false });
  });

  it('refuse anything else', () => {
    for (const value of [null, true, {}, { manual: 'true' }, { automatic: 1 }, []]) {
      expect(parseCheckRequest(value)).toBeNull();
      expect(parseSetAutomaticRequest(value)).toBeNull();
    }
  });
});
