import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The no-network guarantee, asserted rather than promised.
 *
 * The dictionary is an offline feature: the artifact is built ahead of
 * time, shipped with the application and read from disk. Nothing in the
 * subsystem may open a socket, and a future change that adds one should
 * fail here rather than in a user's traffic log.
 *
 * This is a static scan of the source. It cannot prove the absence of
 * cleverly obfuscated access, but it does catch the realistic ways network
 * code arrives: an import, a `fetch`, a request helper.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

const SUBSYSTEM = [
  'src/core/dictionary',
  'src/main/dictionary',
  'src/main/ipc/registerDictionaryIpcHandlers.ts',
  'src/renderer/src/reader/dictionary',
];

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch', /\bfetch\s*\(/u],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['WebSocket', /\bWebSocket\b/u],
  ['EventSource', /\bEventSource\b/u],
  ['navigator.sendBeacon', /\bsendBeacon\b/u],
  ['node:http', /['"]node:https?['"]/u],
  ['node:net', /['"]node:(net|dgram|tls|dns)['"]/u],
  ['electron net', /from\s+['"]electron['"]/u],
  ['a bare http url', /https?:\/\/(?!schemas|www\.w3\.org)/u],
];

const sourceFiles = (entry: string): string[] => {
  const absolute = join(root, entry);

  if (extname(absolute) !== '') {
    return [absolute];
  }

  return readdirSync(absolute, { withFileTypes: true, recursive: true })
    .filter((item) => item.isFile() && /\.tsx?$/u.test(item.name))
    .map((item) => join(item.parentPath, item.name));
};

const files = SUBSYSTEM.flatMap(sourceFiles).filter((file) => !/\.test\.tsx?$/u.test(file));

describe('the dictionary subsystem does not reach the network', () => {
  it('scans every file in the subsystem', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(FORBIDDEN)('contains no %s', (_name, pattern) => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      // Prose in a comment is not an API call; strip block comments first.
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

      return pattern.test(code);
    });

    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('imports nothing outside the application and the Node filesystem', () => {
    const allowed =
      /^(node:fs|node:fs\/promises|node:path|node:url|node:os|react|@core\/|@shared\/|\.{1,2}\/)/u;

    const imports = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => ({
        file: relative(root, file),
        specifier: match[1] ?? '',
      })),
    );

    expect(imports.filter((entry) => !allowed.test(entry.specifier))).toEqual([]);
  });
});
