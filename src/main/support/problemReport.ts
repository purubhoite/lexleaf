/**
 * The "Report a problem" address.
 *
 * Pressing the button opens a new-issue page on GitHub, in the reader's
 * own browser, with a description of this installation already filled in.
 * Nothing is sent by Lexleaf: the reader sees every word of the report,
 * can change or delete any of it, and decides whether to submit it.
 *
 * What is filled in is limited to facts about the application and the
 * machine that someone fixing a problem needs first — which version, which
 * operating system, how it was installed, which graphics driver. No file
 * name, no path, no saved word, no user or computer name: none of them is
 * given to this module, so none of them can end up in the address.
 */

const NEW_ISSUE_ADDRESS = 'https://github.com/purubhoite/lexleaf/issues/new';

/** Keeps one unexpected value from making an address a browser refuses. */
const MAXIMUM_FACT_LENGTH = 120;

export interface InstallationFacts {
  readonly version: string;
  /** `process.platform`. */
  readonly platform: string;
  /** `process.arch`. */
  readonly arch: string;
  /** The operating system's own name for itself, e.g. `Ubuntu 24.04.4 LTS`. */
  readonly systemName: string | null;
  /** The kernel or build number, e.g. `6.8.0-45-generic`, `10.0.22631`. */
  readonly systemRelease: string | null;
  /** How this copy was installed, where that can be told. */
  readonly packaging: 'windows-installer' | 'appimage' | 'deb' | 'development' | 'unknown';
  readonly electronVersion: string;
  readonly chromeVersion: string;
  /** Linux kernel display drivers, e.g. `['i915']`. Empty elsewhere. */
  readonly displayDrivers: readonly string[];
  readonly hardwareAcceleration: boolean;
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
};

const PACKAGING_NAMES: Readonly<Record<InstallationFacts['packaging'], string>> = {
  'windows-installer': 'Windows installer',
  appimage: 'AppImage',
  deb: 'Debian package (.deb)',
  development: 'development build',
  unknown: 'unknown',
};

/** One line of plain text: no line breaks, no markup, bounded. */
const fact = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const plain = value
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .replace(/[`<>[\]|]/gu, '')
    .trim();

  return plain === '' ? null : plain.slice(0, MAXIMUM_FACT_LENGTH);
};

export const describeInstallation = (facts: InstallationFacts): string[] => {
  const system = [
    fact(facts.systemName) ?? PLATFORM_NAMES[facts.platform] ?? fact(facts.platform) ?? 'unknown',
    fact(facts.systemRelease),
    fact(facts.arch),
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  const lines = [
    `- Lexleaf: ${fact(facts.version) ?? 'unknown'}`,
    `- Operating system: ${system}`,
    `- Installed from: ${PACKAGING_NAMES[facts.packaging]}`,
    `- Electron ${fact(facts.electronVersion) ?? 'unknown'}, Chromium ${fact(facts.chromeVersion) ?? 'unknown'}`,
  ];

  if (facts.platform === 'linux') {
    const drivers = facts.displayDrivers
      .map(fact)
      .filter((driver): driver is string => driver !== null);

    lines.push(`- Display driver: ${drivers.length === 0 ? 'unknown' : drivers.join(', ')}`);
  }

  lines.push(`- Graphics acceleration: ${facts.hardwareAcceleration ? 'on' : 'off'}`);

  return lines;
};

export const problemReportBody = (facts: InstallationFacts): string =>
  [
    '### What happened',
    '',
    '<!-- Describe the problem. A screenshot helps. -->',
    '',
    '### What you expected instead',
    '',
    '',
    '### Steps to make it happen again',
    '',
    '1. ',
    '',
    '### About this installation',
    '',
    '<!-- Filled in by Lexleaf. It contains no file names and nothing you saved; remove anything you would rather not share. -->',
    '',
    ...describeInstallation(facts),
    '',
  ].join('\n');

export const problemReportAddress = (facts: InstallationFacts): string => {
  const address = new URL(NEW_ISSUE_ADDRESS);

  address.searchParams.set('body', problemReportBody(facts));

  return address.href;
};

/**
 * How this copy was installed.
 *
 * An AppImage says so in its environment. A packaged Linux build that is
 * not one was installed from the Debian package — the only other Linux
 * form Lexleaf is published in.
 */
export const detectPackaging = ({
  platform,
  packaged,
  env,
}: {
  readonly platform: string;
  readonly packaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): InstallationFacts['packaging'] => {
  if (!packaged) {
    return 'development';
  }

  if (platform === 'win32') {
    return 'windows-installer';
  }

  if (platform === 'linux') {
    return (env['APPIMAGE'] ?? '') === '' ? 'deb' : 'appimage';
  }

  return 'unknown';
};

/** `PRETTY_NAME` from an `os-release` file, or `null`. */
export const parseOsReleaseName = (contents: string | null): string | null => {
  if (contents === null) {
    return null;
  }

  const match = /^PRETTY_NAME=(.*)$/mu.exec(contents);

  if (match === null) {
    return null;
  }

  const raw = (match[1] ?? '').trim();
  const unquoted = /^"(.*)"$/u.exec(raw)?.[1] ?? /^'(.*)'$/u.exec(raw)?.[1] ?? raw;

  return unquoted.trim() === '' ? null : unquoted.trim();
};
