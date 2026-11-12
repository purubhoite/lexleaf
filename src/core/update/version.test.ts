import { describe, expect, it } from 'vitest';

import {
  formatReleaseVersion,
  isNewerVersion,
  parseLatestRelease,
  parseReleaseVersion,
} from './version';

describe('parseReleaseVersion', () => {
  it('reads a plain version, with or without the tag prefix', () => {
    expect(parseReleaseVersion('0.1.1')).toStrictEqual([0, 1, 1]);
    expect(parseReleaseVersion('v12.0.34')).toStrictEqual([12, 0, 34]);
    expect(parseReleaseVersion(' v1.2.3 ')).toStrictEqual([1, 2, 3]);
  });

  it.each([
    '1.2',
    '1.2.3.4',
    '1.2.3-beta.1',
    '1.2.3+build',
    'version 1.2.3',
    'v',
    '',
    '1.2.x',
    '1.2.3\nmalicious',
    '9999999.0.0',
  ])('refuses %j', (value) => {
    expect(parseReleaseVersion(value)).toBeNull();
  });

  it('refuses anything that is not text', () => {
    for (const value of [null, undefined, 1, {}, ['1.2.3']]) {
      expect(parseReleaseVersion(value)).toBeNull();
    }
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, most significant part first', () => {
    expect(isNewerVersion([0, 1, 1], [0, 1, 0])).toBe(true);
    expect(isNewerVersion([0, 2, 0], [0, 1, 9])).toBe(true);
    expect(isNewerVersion([1, 0, 0], [0, 99, 99])).toBe(true);
    expect(isNewerVersion([0, 10, 0], [0, 9, 0])).toBe(true);
  });

  it('is false for the same version and for an older one', () => {
    expect(isNewerVersion([0, 1, 1], [0, 1, 1])).toBe(false);
    expect(isNewerVersion([0, 1, 0], [0, 1, 1])).toBe(false);
    expect(isNewerVersion([0, 9, 9], [1, 0, 0])).toBe(false);
  });
});

describe('formatReleaseVersion', () => {
  it('writes the version without a prefix', () => {
    expect(formatReleaseVersion([0, 1, 1])).toBe('0.1.1');
  });
});

describe('parseLatestRelease', () => {
  it('reads the tag of a published release', () => {
    expect(
      parseLatestRelease({ tag_name: 'v0.2.0', draft: false, prerelease: false }),
    ).toStrictEqual([0, 2, 0]);
  });

  it('ignores drafts and pre-releases', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0', draft: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v0.2.0', prerelease: true })).toBeNull();
  });

  it('refuses a reply that is not a release', () => {
    for (const payload of [null, 'v0.2.0', [], {}, { tag_name: 5 }, { tag_name: 'latest' }]) {
      expect(parseLatestRelease(payload)).toBeNull();
    }
  });
});
