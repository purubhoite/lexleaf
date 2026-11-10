#!/usr/bin/env node
/**
 * Builds the synthetic dictionary used by the tests.
 *
 *   node scripts/dictionary/build-fixture.mjs [--out <dir>]
 *
 * The fixture is produced by the same writer as the shipped artifact, so the
 * tests exercise the real file format rather than a test-only imitation, and
 * no test ever needs the 29 MB release. Both the synthetic source and the
 * built fixture are committed: they are small, and a test suite that cannot
 * run without a download is not a test suite.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifact } from './lib/artifact.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../..');

export const FIXTURE_SOURCE = join(projectRoot, 'tests/fixtures/dictionary/source.json');
export const FIXTURE_OUTPUT = join(projectRoot, 'tests/fixtures/dictionary');

/**
 * Writes the fixture artifact.
 *
 * @param {string} outDir where to write it
 */
export const buildFixture = (outDir = FIXTURE_OUTPUT) => {
  const raw = readFileSync(FIXTURE_SOURCE);
  const definition = JSON.parse(raw.toString('utf8'));
  const digest = createHash('sha256').update(raw).digest('hex');

  const entries = new Map();
  let senseCount = 0;

  // Sorted so the build does not depend on the order of the JSON file.
  for (const key of Object.keys(definition.entries).sort()) {
    const entry = definition.entries[key];

    entries.set(
      key,
      entry.pr === undefined ? { senses: entry.senses } : { senses: entry.senses, pr: entry.pr },
    );
    senseCount += entry.senses.length;
  }

  const exceptionCount = Object.values(definition.exceptions).reduce(
    (total, table) => total + Object.keys(table).length,
    0,
  );

  return writeArtifact({
    outDir,
    entries,
    exceptions: definition.exceptions,
    licenceHeader:
      'Synthetic test data. Written for this project; not derived from WordNet or any other dictionary.\n',
    source: {
      dataset: 'Synthetic test dictionary',
      release: 'fixture-1',
      transformVersion: '1.0.0',
      archive: { url: 'file://tests/fixtures/dictionary/source.json', sha256: digest },
      pronunciation: { url: 'file://tests/fixtures/dictionary/source.json', sha256: digest },
      licences: [
        {
          name: 'Project test fixture (not for redistribution as a dictionary)',
          url: 'file://AGENTS.md',
        },
      ],
      credits: ['Synthetic data written for the Intelligent PDF Reader test suite.'],
      modificationStatement:
        'Modified: this fixture is entirely synthetic and exists only to exercise the lookup pipeline.',
    },
    counts: {
      headwords: entries.size,
      senses: senseCount,
      pronunciations: [...entries.values()].filter((entry) => entry.pr !== undefined).length,
      morphologicalExceptions: exceptionCount,
    },
  });
};

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).endsWith(join('dictionary', 'build-fixture.mjs'));

if (isMain) {
  const index = process.argv.indexOf('--out');
  const outDir = index === -1 ? FIXTURE_OUTPUT : resolve(process.argv[index + 1]);
  const { manifest } = buildFixture(outDir);

  console.log(JSON.stringify({ outDir, counts: manifest.counts, files: manifest.files }, null, 2));
}
