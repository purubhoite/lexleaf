#!/usr/bin/env node
/**
 * Fetches and verifies the pinned dictionary source release.
 *
 *   node scripts/dictionary/fetch-source.mjs [--cache <dir>]
 *
 * Downloads happen **outside the repository**, into a cache directory
 * (`~/.cache/intelligent-pdf-reader/dictionary/<release>` by default), and
 * every file is checked against the SHA-256 pinned in `source.json` before
 * it is used. A mismatch fails the build: the application must never be
 * built from a release that is not the one it claims to ship.
 *
 * This is the only place in the project that touches the network, and it is
 * a build-time tool. Nothing in `src/` fetches anything, ever.
 */

/* global fetch */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readZip } from './lib/unzip.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const projectRoot = resolve(scriptDir, '../..');

export const loadSource = async () =>
  JSON.parse(await readFile(join(scriptDir, 'source.json'), 'utf8'));

export const defaultCacheDirectory = (release) =>
  join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'intelligent-pdf-reader',
    'dictionary',
    release,
  );

const exists = async (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

const hashFile = async (path) => {
  const hash = createHash('sha256');

  await pipeline(createReadStream(path), hash);

  return hash.digest('hex');
};

const download = async (url, destination) => {
  const response = await fetch(url, { redirect: 'follow' });

  if (!response.ok || response.body === null) {
    throw new Error(`download failed with status ${String(response.status)}: ${url}`);
  }

  const temporary = `${destination}.partial`;

  await pipeline(response.body, createWriteStream(temporary));
  await rename(temporary, destination);
};

/**
 * Ensures one pinned file is present and verified.
 *
 * @returns {Promise<string>} the path to the verified file
 */
const ensureFile = async (spec, cacheDir, log) => {
  const path = join(cacheDir, spec.fileName);

  if (!(await exists(path))) {
    log(`downloading ${spec.url}`);
    await download(spec.url, path);
  }

  const size = (await stat(path)).size;

  if (size !== spec.bytes) {
    throw new Error(
      `${spec.fileName} is ${String(size)} bytes, expected ${String(spec.bytes)}: refusing to build`,
    );
  }

  const digest = await hashFile(path);

  if (digest !== spec.sha256) {
    throw new Error(
      `${spec.fileName} SHA-256 ${digest} does not match the pinned ${spec.sha256}: refusing to build`,
    );
  }

  log(`verified ${spec.fileName} (${String(size)} bytes, sha256 ${digest})`);

  return path;
};

/**
 * Downloads, verifies and unpacks the pinned release.
 *
 * @returns {Promise<{ databaseDir: string, lmfPath: string, cacheDir: string }>}
 */
export const ensureSource = async ({ cacheDir, log = () => {} } = {}) => {
  const source = await loadSource();
  const directory = cacheDir ?? defaultCacheDirectory(source.release);

  await mkdir(directory, { recursive: true });

  const archivePath = await ensureFile(source.archive, directory, log);

  const databaseDir = join(directory, source.archive.databaseDirectory);

  if (!(await exists(join(databaseDir, 'data.noun')))) {
    log(`unpacking ${source.archive.fileName}`);

    for (const file of readZip(await readFile(archivePath))) {
      if (file.name.endsWith('/')) {
        continue;
      }

      const target = join(directory, file.name);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.read());
    }
  }

  return { databaseDir, cacheDir: directory, source };
};

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const cacheIndex = process.argv.indexOf('--cache');
  const cacheDir = cacheIndex === -1 ? undefined : process.argv[cacheIndex + 1];

  ensureSource({ cacheDir, log: (message) => console.log(`[dictionary] ${message}`) }).then(
    ({ cacheDir: used }) => {
      console.log(`[dictionary] source ready in ${used}`);
    },
    (error) => {
      console.error(`[dictionary] ${error.message}`);
      process.exit(1);
    },
  );
}
