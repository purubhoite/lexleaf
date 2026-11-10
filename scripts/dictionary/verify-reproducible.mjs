#!/usr/bin/env node
/**
 * Checks that the dictionary build is reproducible.
 *
 *   node scripts/dictionary/verify-reproducible.mjs [--cache <dir>]
 *
 * Builds the artifact twice into two temporary directories and compares the
 * SHA-256 of every generated file. A difference means something in the
 * pipeline depends on the clock, the locale, a path or an iteration order,
 * and the build is not trustworthy as a release input.
 *
 * Exits non-zero on any difference.
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDictionary } from './build.mjs';

const digestsOf = (directory) =>
  Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(directory, name)))
          .digest('hex'),
      ]),
  );

const argument = (name) => {
  const index = process.argv.indexOf(name);

  return index === -1 ? undefined : process.argv[index + 1];
};

const run = async () => {
  const cacheDir = argument('--cache');
  const first = mkdtempSync(join(tmpdir(), 'dictionary-build-'));
  const second = mkdtempSync(join(tmpdir(), 'dictionary-build-'));

  try {
    const started = Date.now();

    await buildDictionary({ outDir: first, cacheDir, log: () => {} });
    const firstElapsed = Date.now() - started;

    const restarted = Date.now();

    await buildDictionary({ outDir: second, cacheDir, log: () => {} });
    const secondElapsed = Date.now() - restarted;

    const left = digestsOf(first);
    const right = digestsOf(second);
    const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    const differences = names.filter((name) => left[name] !== right[name]);

    console.log(
      JSON.stringify(
        {
          builds: [
            { milliseconds: firstElapsed, digests: left },
            { milliseconds: secondElapsed, digests: right },
          ],
          identical: differences.length === 0,
          differences,
        },
        null,
        2,
      ),
    );

    if (differences.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(`[dictionary] ${error.message}`);
  process.exit(1);
});
