import { describe, expect, it, vi } from 'vitest';

import {
  canInstallUpdates,
  createElectronUpdaterInstaller,
  type AutoUpdaterLike,
} from './updateInstaller';

const updaterStub = (offered: string | null = '0.2.0') => {
  const updater: AutoUpdaterLike = {
    // The library's own defaults, which the adapter must override.
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn(() =>
      Promise.resolve(offered === null ? null : { updateInfo: { version: offered } }),
    ),
    downloadUpdate: vi.fn(() => Promise.resolve(['/tmp/update'])),
    quitAndInstall: vi.fn(),
  };

  return updater;
};

const build = (updater: AutoUpdaterLike, currentVersion = '0.1.1') => {
  const load = vi.fn(() => Promise.resolve(updater));

  return { load, installer: createElectronUpdaterInstaller({ currentVersion, load }) };
};

describe('the installer adapter', () => {
  it('does not load the library until a download is asked for', () => {
    const { load, installer } = build(updaterStub());

    installer.install();

    expect(load).not.toHaveBeenCalled();
  });

  it('switches off everything the library would do by itself', async () => {
    const updater = updaterStub();
    const { installer } = build(updater);

    await installer.download();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it('checks the feed, then downloads, and installs nothing', async () => {
    const updater = updaterStub();
    const { installer } = build(updater);

    await installer.download();

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', null],
    ['the running version', '0.1.1'],
    ['an older version', '0.1.0'],
    ['a pre-release', '0.2.0-beta.1'],
    ['something that is not a version', 'latest'],
  ])('refuses to download when the feed offers %s', async (_name, offered) => {
    const updater = updaterStub(offered);
    const { installer } = build(updater);

    await expect(installer.download()).rejects.toThrow(/did not offer a newer release/u);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    installer.install();

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('passes a failed download on, and will not install after it', async () => {
    const updater = updaterStub();

    updater.downloadUpdate = vi.fn(() => Promise.reject(new Error('sha512 checksum mismatch')));

    const { installer } = build(updater);

    await expect(installer.download()).rejects.toThrow(/checksum/u);

    installer.install();

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('installs silently and restarts, once a download has finished', async () => {
    const updater = updaterStub();
    const { load, installer } = build(updater);

    await installer.download();
    installer.install();

    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
    expect(load).toHaveBeenCalledOnce();
  });
});

describe('which installations can replace themselves', () => {
  it('is a packaged Windows installation or a packaged AppImage', () => {
    expect(canInstallUpdates({ packaged: true, platform: 'win32', env: {} })).toBe(true);
    expect(
      canInstallUpdates({
        packaged: true,
        platform: 'linux',
        env: { APPIMAGE: '/home/reader/Lexleaf.AppImage' },
      }),
    ).toBe(true);
  });

  it('is not a Debian package, a development build or another platform', () => {
    expect(canInstallUpdates({ packaged: true, platform: 'linux', env: {} })).toBe(false);
    expect(canInstallUpdates({ packaged: true, platform: 'linux', env: { APPIMAGE: '' } })).toBe(
      false,
    );
    expect(canInstallUpdates({ packaged: false, platform: 'win32', env: {} })).toBe(false);
    expect(canInstallUpdates({ packaged: true, platform: 'darwin', env: {} })).toBe(false);
  });
});
