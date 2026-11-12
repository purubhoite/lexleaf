import { describe, expect, it, vi } from 'vitest';

import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  LATEST_RELEASE_ADDRESS,
  createUpdateService,
  type UpdateServiceOptions,
} from './updateService';
import {
  DEFAULT_UPDATE_SETTINGS,
  createUpdateSettingsStore,
  parseUpdateSettings,
  type UpdateSettings,
} from './updateSettings';

const NOW = new Date('2026-11-12T10:00:00.000Z');

const memoryStore = (initial: Partial<UpdateSettings> = {}) => {
  let value: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS, ...initial };

  return {
    read: vi.fn(() => Promise.resolve(value)),
    write: vi.fn((next: UpdateSettings) => {
      value = next;

      return Promise.resolve();
    }),
    current: (): UpdateSettings => value,
  };
};

const release = (tag: string): Promise<unknown> =>
  Promise.resolve({ tag_name: tag, draft: false, prerelease: false });

const build = (
  overrides: Partial<UpdateServiceOptions> = {},
  stored: Partial<UpdateSettings> = {},
) => {
  const settings = memoryStore(stored);
  const fetchLatestRelease = vi.fn<(address: string) => Promise<unknown>>(() => release('v0.2.0'));
  const openExternal = vi.fn();
  const service = createUpdateService({
    currentVersion: '0.1.1',
    settings,
    fetchLatestRelease,
    openExternal,
    now: () => NOW,
    ...overrides,
  });

  return { service, settings, fetchLatestRelease, openExternal };
};

describe('the automatic check', () => {
  it('reports a newer release and remembers what it saw', async () => {
    const { service, settings, fetchLatestRelease } = build();

    expect(await service.check({ manual: false })).toStrictEqual({
      automatic: true,
      outcome: { status: 'available', version: '0.2.0', canInstall: false },
    });
    expect(fetchLatestRelease).toHaveBeenCalledExactlyOnceWith(LATEST_RELEASE_ADDRESS);
    expect(settings.current()).toStrictEqual({
      automatic: true,
      lastCheckedAt: NOW.toISOString(),
      latestSeenVersion: '0.2.0',
    });
  });

  it('says the build is current when the release is the same or older', async () => {
    for (const tag of ['v0.1.1', 'v0.1.0']) {
      const { service } = build({ fetchLatestRelease: () => release(tag) });

      expect((await service.check({ manual: false })).outcome).toStrictEqual({
        status: 'up-to-date',
      });
    }
  });

  it('contacts nothing when the reader has turned it off', async () => {
    const { service, fetchLatestRelease } = build({}, { automatic: false });

    expect(await service.check({ manual: false })).toStrictEqual({
      automatic: false,
      outcome: { status: 'idle' },
    });
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('contacts nothing in a build where automatic checks are not allowed', async () => {
    const { service, fetchLatestRelease } = build({ automaticChecksAllowed: false });

    expect((await service.check({ manual: false })).outcome).toStrictEqual({ status: 'idle' });
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('answers from memory inside the daily window, without a request', async () => {
    const recent = new Date(NOW.getTime() - AUTOMATIC_CHECK_INTERVAL_MS + 1).toISOString();
    const { service, fetchLatestRelease } = build(
      {},
      { lastCheckedAt: recent, latestSeenVersion: '0.3.0' },
    );

    expect((await service.check({ manual: false })).outcome).toStrictEqual({
      status: 'available',
      version: '0.3.0',
      canInstall: false,
    });
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('asks again once the window has passed', async () => {
    const old = new Date(NOW.getTime() - AUTOMATIC_CHECK_INTERVAL_MS).toISOString();
    const { service, fetchLatestRelease } = build(
      {},
      { lastCheckedAt: old, latestSeenVersion: '0.1.1' },
    );

    await service.check({ manual: false });

    expect(fetchLatestRelease).toHaveBeenCalledOnce();
  });

  it('asks again when the stored time is in the future', async () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const { service, fetchLatestRelease } = build({}, { lastCheckedAt: future });

    await service.check({ manual: false });

    expect(fetchLatestRelease).toHaveBeenCalledOnce();
  });

  it('stays silent when the request fails, and does not record a check', async () => {
    const onDiagnostic = vi.fn();
    const { service, settings } = build({
      fetchLatestRelease: () => Promise.reject(new TypeError('offline')),
      onDiagnostic,
    });

    expect((await service.check({ manual: false })).outcome).toStrictEqual({ status: 'idle' });
    expect(settings.write).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith('update check failed: TypeError');
  });
});

describe('a check the reader asked for', () => {
  it('always contacts, even when automatic checks are off and the answer is fresh', async () => {
    const { service, fetchLatestRelease } = build(
      { automaticChecksAllowed: false },
      { automatic: false, lastCheckedAt: NOW.toISOString(), latestSeenVersion: '0.1.1' },
    );

    expect(await service.check({ manual: true })).toStrictEqual({
      automatic: false,
      outcome: { status: 'available', version: '0.2.0', canInstall: false },
    });
    expect(fetchLatestRelease).toHaveBeenCalledOnce();
  });

  it('says so when it fails', async () => {
    const { service } = build({ fetchLatestRelease: () => Promise.reject(new Error('boom')) });

    expect((await service.check({ manual: true })).outcome).toStrictEqual({ status: 'failed' });
  });

  it.each([
    ['a reply that is not a release', { message: 'Not Found' }],
    ['a pre-release', { tag_name: 'v9.0.0', prerelease: true }],
    ['a tag that is not a version', { tag_name: 'nightly' }],
  ])('fails on %s', async (_name, payload) => {
    const { service, openExternal } = build({
      fetchLatestRelease: () => Promise.resolve(payload),
    });

    expect((await service.check({ manual: true })).outcome).toStrictEqual({ status: 'failed' });

    service.openDownload();

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('shares one request between callers that overlap', async () => {
    const { service, fetchLatestRelease } = build();

    await Promise.all([service.check({ manual: true }), service.check({ manual: true })]);

    expect(fetchLatestRelease).toHaveBeenCalledOnce();
  });

  it('does nothing in a build that cannot name its own version', async () => {
    const { service, fetchLatestRelease } = build({ currentVersion: 'development' });

    expect((await service.check({ manual: true })).outcome).toStrictEqual({ status: 'idle' });
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });
});

describe('opening the download page', () => {
  it('opens the page for the version that was found, built from that version alone', async () => {
    const { service, openExternal } = build({
      fetchLatestRelease: () =>
        Promise.resolve({
          tag_name: 'v0.2.0',
          html_url: 'https://evil.example/download',
          assets: [{ browser_download_url: 'https://evil.example/setup.exe' }],
        }),
    });

    await service.check({ manual: true });
    service.openDownload();

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      'https://github.com/purubhoite/lexleaf/releases/tag/v0.2.0',
    );
  });

  it('opens nothing before a newer release has been found', async () => {
    const { service, openExternal } = build({ fetchLatestRelease: () => release('v0.1.1') });

    service.openDownload();
    await service.check({ manual: true });
    service.openDownload();

    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('downloading and installing', () => {
  const installerStub = (download: () => Promise<void> = () => Promise.resolve()) => ({
    download: vi.fn(download),
    install: vi.fn(),
  });

  it('offers the in-app install only when this installation has an installer', async () => {
    const { service } = build({ installer: installerStub() });

    expect((await service.check({ manual: true })).outcome).toStrictEqual({
      status: 'available',
      version: '0.2.0',
      canInstall: true,
    });
  });

  it('downloads only when asked, and never installs by itself', async () => {
    const installer = installerStub();
    const { service } = build({ installer });

    await service.check({ manual: true });

    expect(installer.download).not.toHaveBeenCalled();

    expect((await service.download()).outcome).toStrictEqual({ status: 'ready', version: '0.2.0' });
    expect(installer.download).toHaveBeenCalledOnce();
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('reports the download while it is running, and shares it between callers', async () => {
    let finish: () => void = () => {};
    const installer = installerStub(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { service } = build({ installer });

    await service.check({ manual: true });

    const first = service.download();
    const second = service.download();

    await Promise.resolve();

    expect((await service.check({ manual: true })).outcome).toStrictEqual({
      status: 'downloading',
      version: '0.2.0',
    });

    finish();

    expect((await first).outcome.status).toBe('ready');
    expect((await second).outcome.status).toBe('ready');
    expect(installer.download).toHaveBeenCalledOnce();
  });

  it('says so when the download fails, and can be asked again', async () => {
    const onDiagnostic = vi.fn();
    let attempts = 0;
    const installer = installerStub(() => {
      attempts += 1;

      return attempts === 1 ? Promise.reject(new RangeError('sha512 mismatch')) : Promise.resolve();
    });
    const { service } = build({ installer, onDiagnostic });

    await service.check({ manual: true });

    expect((await service.download()).outcome).toStrictEqual({
      status: 'download-failed',
      version: '0.2.0',
    });
    expect(onDiagnostic).toHaveBeenCalledWith('update download failed: RangeError');
    expect((await service.download()).outcome.status).toBe('ready');
  });

  it('keeps a finished download through a later check', async () => {
    const installer = installerStub();
    const { service } = build({ installer });

    await service.check({ manual: true });
    await service.download();

    expect((await service.check({ manual: true })).outcome).toStrictEqual({
      status: 'ready',
      version: '0.2.0',
    });
    expect((await service.download()).outcome.status).toBe('ready');
    expect(installer.download).toHaveBeenCalledOnce();
  });

  it('saves state first, then installs, and only once a download is ready', async () => {
    const order: string[] = [];
    const installer = {
      download: vi.fn(() => Promise.resolve()),
      install: vi.fn(() => {
        order.push('install');
      }),
    };
    const { service } = build({
      installer,
      beforeInstall: () => {
        order.push('save');

        return Promise.resolve();
      },
    });

    await service.install();
    await service.check({ manual: true });
    await service.install();

    expect(order).toStrictEqual([]);

    await service.download();
    await service.install();

    expect(order).toStrictEqual(['save', 'install']);
  });

  it('still installs when saving state fails', async () => {
    const installer = installerStub();
    const { service } = build({
      installer,
      beforeInstall: () => Promise.reject(new Error('disk full')),
    });

    await service.check({ manual: true });
    await service.download();
    await service.install();

    expect(installer.install).toHaveBeenCalledOnce();
  });

  it('does nothing without an installer or without a newer release', async () => {
    const without = build();

    await without.service.check({ manual: true });

    expect((await without.service.download()).outcome).toStrictEqual({
      status: 'available',
      version: '0.2.0',
      canInstall: false,
    });

    const installer = installerStub();
    const current = build({ installer, fetchLatestRelease: () => release('v0.1.1') });

    await current.service.check({ manual: true });

    expect((await current.service.download()).outcome).toStrictEqual({ status: 'idle' });
    expect(installer.download).not.toHaveBeenCalled();
  });
});

describe('the setting', () => {
  it('is stored, and keeps what is already known', async () => {
    const { service, settings } = build();

    await service.check({ manual: true });

    expect(await service.setAutomatic(false)).toStrictEqual({
      automatic: false,
      outcome: { status: 'available', version: '0.2.0', canInstall: false },
    });
    expect(settings.current().automatic).toBe(false);
    expect(settings.current().latestSeenVersion).toBe('0.2.0');
  });
});

describe('the settings file', () => {
  it('reads as the defaults when missing or damaged', async () => {
    for (const readFile of [
      (): Promise<string> => Promise.reject(new Error('ENOENT')),
      (): Promise<string> => Promise.resolve('{ not json'),
      (): Promise<string> => Promise.resolve('[]'),
    ]) {
      const store = createUpdateSettingsStore({
        filePath: '/profile/update-settings.json',
        files: { readFile, writeFile: () => Promise.resolve() },
      });

      expect(await store.read()).toStrictEqual(DEFAULT_UPDATE_SETTINGS);
    }
  });

  it('turns the check off only for an explicit false, and keeps only valid values', () => {
    expect(parseUpdateSettings({ automatic: false }).automatic).toBe(false);
    expect(parseUpdateSettings({ automatic: 'no' }).automatic).toBe(true);
    expect(
      parseUpdateSettings({
        automatic: true,
        lastCheckedAt: 'yesterday',
        latestSeenVersion: 'https://example.com/',
        extra: 'dropped',
      }),
    ).toStrictEqual(DEFAULT_UPDATE_SETTINGS);
  });

  it('writes what it was given and reports a failed write without throwing', async () => {
    const written: string[] = [];
    const onDiagnostic = vi.fn();
    const next: UpdateSettings = {
      automatic: false,
      lastCheckedAt: NOW.toISOString(),
      latestSeenVersion: '0.2.0',
    };

    const working = createUpdateSettingsStore({
      filePath: '/profile/update-settings.json',
      files: {
        readFile: () => Promise.reject(new Error('ENOENT')),
        writeFile: (_path, contents) => {
          written.push(contents);

          return Promise.resolve();
        },
      },
    });

    await working.write(next);

    expect(JSON.parse(written[0] ?? '')).toStrictEqual(next);
    expect(await working.read()).toStrictEqual(next);

    const failing = createUpdateSettingsStore({
      filePath: '/profile/update-settings.json',
      files: {
        readFile: () => Promise.reject(new Error('ENOENT')),
        writeFile: () => Promise.reject(new RangeError('disk full')),
      },
      onDiagnostic,
    });

    await expect(failing.write(next)).resolves.toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledWith('update settings could not be saved: RangeError');
  });
});
