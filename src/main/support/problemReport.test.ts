import { describe, expect, it } from 'vitest';

import {
  describeInstallation,
  detectPackaging,
  parseOsReleaseName,
  problemReportAddress,
  problemReportBody,
  type InstallationFacts,
} from './problemReport';

const ubuntu: InstallationFacts = {
  version: '0.2.3',
  platform: 'linux',
  arch: 'x64',
  systemName: 'Ubuntu 24.04.4 LTS',
  systemRelease: '6.8.0-45-generic',
  packaging: 'deb',
  electronVersion: '41.7.1',
  chromeVersion: '146.0.0.0',
  displayDrivers: ['nouveau'],
  hardwareAcceleration: false,
};

const windows: InstallationFacts = {
  ...ubuntu,
  platform: 'win32',
  systemName: 'Windows 11 Home',
  systemRelease: '10.0.22631',
  packaging: 'windows-installer',
  displayDrivers: [],
  hardwareAcceleration: true,
};

describe('describing the installation', () => {
  it('lists what someone fixing a problem needs first', () => {
    expect(describeInstallation(ubuntu)).toStrictEqual([
      '- Lexleaf: 0.2.3',
      '- Operating system: Ubuntu 24.04.4 LTS, 6.8.0-45-generic, x64',
      '- Installed from: Debian package (.deb)',
      '- Electron 41.7.1, Chromium 146.0.0.0',
      '- Display driver: nouveau',
      '- Graphics acceleration: off',
    ]);
  });

  it('has no display-driver line where there is nothing to read one from', () => {
    expect(describeInstallation(windows)).toStrictEqual([
      '- Lexleaf: 0.2.3',
      '- Operating system: Windows 11 Home, 10.0.22631, x64',
      '- Installed from: Windows installer',
      '- Electron 41.7.1, Chromium 146.0.0.0',
      '- Graphics acceleration: on',
    ]);
  });

  it('says so when something is not known', () => {
    const lines = describeInstallation({
      ...ubuntu,
      systemName: null,
      systemRelease: null,
      displayDrivers: [],
      packaging: 'unknown',
    });

    expect(lines[1]).toBe('- Operating system: Linux, x64');
    expect(lines[2]).toBe('- Installed from: unknown');
    expect(lines[4]).toBe('- Display driver: unknown');
  });

  it('keeps a strange value to one bounded line without markup', () => {
    const lines = describeInstallation({
      ...ubuntu,
      systemName: 'Odd\nOS <script>alert(1)</script> [link](https://example.com) `code` | cell',
      systemRelease: 'r'.repeat(500),
    });

    expect(lines).toHaveLength(6);
    expect(lines[1]).not.toMatch(/[\n<>`[\]|]/u);
    expect((lines[1] ?? '').length).toBeLessThan(300);
  });
});

describe('the report address', () => {
  it('opens a new issue in the Lexleaf repository and nowhere else', () => {
    const address = new URL(problemReportAddress(ubuntu));

    expect(address.protocol).toBe('https:');
    expect(address.host).toBe('github.com');
    expect(address.pathname).toBe('/purubhoite/lexleaf/issues/new');
    expect([...address.searchParams.keys()]).toStrictEqual(['body']);
  });

  it('carries the body intact, with room for the reader to write', () => {
    const body = new URL(problemReportAddress(ubuntu)).searchParams.get('body');

    expect(body).toBe(problemReportBody(ubuntu));
    expect(body).toContain('### What happened');
    expect(body).toContain('### Steps to make it happen again');
    expect(body).toContain('- Lexleaf: 0.2.3');
    expect(body).toContain('remove anything you would rather not share');
  });

  it('stays short enough for a browser and for GitHub', () => {
    expect(problemReportAddress(ubuntu).length).toBeLessThan(2_000);
    expect(
      problemReportAddress({
        ...ubuntu,
        systemName: 'n'.repeat(5_000),
        systemRelease: 'r'.repeat(5_000),
        version: 'v'.repeat(5_000),
        displayDrivers: Array.from({ length: 4 }, () => 'd'.repeat(5_000)),
      }).length,
    ).toBeLessThan(4_000);
  });
});

describe('how this copy was installed', () => {
  it('tells the published forms apart', () => {
    expect(detectPackaging({ platform: 'win32', packaged: true, env: {} })).toBe(
      'windows-installer',
    );
    expect(
      detectPackaging({ platform: 'linux', packaged: true, env: { APPIMAGE: '/x/L.AppImage' } }),
    ).toBe('appimage');
    expect(detectPackaging({ platform: 'linux', packaged: true, env: { APPIMAGE: '' } })).toBe(
      'deb',
    );
    expect(detectPackaging({ platform: 'darwin', packaged: true, env: {} })).toBe('unknown');
    expect(detectPackaging({ platform: 'linux', packaged: false, env: {} })).toBe('development');
  });
});

describe('reading the system name', () => {
  it('takes PRETTY_NAME, quoted or not', () => {
    expect(parseOsReleaseName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\nID=ubuntu\n')).toBe(
      'Ubuntu 24.04.4 LTS',
    );
    expect(parseOsReleaseName("PRETTY_NAME='Linux Mint 22'\n")).toBe('Linux Mint 22');
    expect(parseOsReleaseName('PRETTY_NAME=Arch\n')).toBe('Arch');
  });

  it('is nothing when the file is missing or does not say', () => {
    expect(parseOsReleaseName(null)).toBeNull();
    expect(parseOsReleaseName('NAME=Ubuntu\n')).toBeNull();
    expect(parseOsReleaseName('PRETTY_NAME=""\n')).toBeNull();
  });
});
