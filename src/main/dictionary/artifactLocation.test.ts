import { describe, expect, it } from 'vitest';

import { artifactCandidates, resolveArtifactDirectory } from './artifactLocation';

describe('artifact location', () => {
  it('looks beside the application first when packaged', () => {
    expect(
      artifactCandidates({
        appPath: '/opt/app/resources/app.asar',
        resourcesPath: '/opt/app/resources',
        packaged: true,
      }),
    ).toEqual([
      '/opt/app/resources/dictionary',
      '/opt/app/resources/app.asar.unpacked/resources/dictionary',
      '/opt/app/resources/app.asar/resources/dictionary',
    ]);
  });

  it('looks in the project tree when running from source', () => {
    expect(
      artifactCandidates({ appPath: '/work/reader', resourcesPath: null, packaged: false }),
    ).toEqual(['/work/reader/resources/dictionary']);
  });

  it('picks the first candidate that has a manifest', () => {
    const present = new Set(['/opt/app/resources/app.asar.unpacked/resources/dictionary']);

    expect(
      resolveArtifactDirectory(
        {
          appPath: '/opt/app/resources/app.asar',
          resourcesPath: '/opt/app/resources',
          packaged: true,
        },
        (directory) => present.has(directory),
      ),
    ).toBe('/opt/app/resources/app.asar.unpacked/resources/dictionary');
  });

  it('reports nothing when the dictionary is not installed', () => {
    expect(
      resolveArtifactDirectory(
        { appPath: '/work/reader', resourcesPath: null, packaged: false },
        () => false,
      ),
    ).toBeNull();
  });
});
