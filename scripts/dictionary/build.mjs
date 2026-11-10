#!/usr/bin/env node
/**
 * Builds the shipped dictionary artifact from the pinned source release.
 *
 *   node scripts/dictionary/build.mjs [--out <dir>] [--cache <dir>] [--quiet]
 *
 * Pipeline: pinned release → fetch outside the repository → SHA-256
 * verification → structural validation → deterministic transformation →
 * JSONL payload + binary index → notices → manifest.
 *
 * The output (`resources/dictionary` by default) is generated and is not
 * committed; see `.gitignore`. The application reads it at runtime and never
 * downloads anything.
 */

import { join, resolve } from 'node:path';

import { writeArtifact } from './lib/artifact.mjs';
import { readEntries, readExceptions, readLicenceHeader } from './lib/wndb.mjs';
import { ensureSource, projectRoot } from './fetch-source.mjs';

/** Sanity thresholds. A release that falls short of these is not the one we pinned. */
const MINIMUM_HEADWORDS = 100_000;
const MINIMUM_SENSES = 150_000;
const MINIMUM_EXCEPTIONS = 4_000;

const argument = (name) => {
  const index = process.argv.indexOf(name);

  return index === -1 ? undefined : process.argv[index + 1];
};

export const buildDictionary = async ({ outDir, cacheDir, log = () => {} }) => {
  const { databaseDir, source } = await ensureSource({ cacheDir, log });

  log('reading the database files');

  const licenceHeader = readLicenceHeader(databaseDir);
  const { entries, senseCount } = readEntries(databaseDir, source.limits);
  const { exceptions, count: exceptionCount } = readExceptions(databaseDir);

  // Validation before anything is written: a half-parsed release must fail
  // the build rather than produce a thin dictionary that looks fine.
  if (entries.size < MINIMUM_HEADWORDS) {
    throw new Error(`only ${String(entries.size)} headwords parsed; the release looks wrong`);
  }

  if (senseCount < MINIMUM_SENSES) {
    throw new Error(`only ${String(senseCount)} senses parsed; the release looks wrong`);
  }

  if (exceptionCount < MINIMUM_EXCEPTIONS) {
    throw new Error(
      `only ${String(exceptionCount)} morphological exceptions; the release looks wrong`,
    );
  }

  log('writing the artifact');

  const { manifest, sizes } = writeArtifact({
    outDir,
    entries,
    exceptions,
    source,
    licenceHeader,
    counts: {
      headwords: entries.size,
      senses: senseCount,
      pronunciations: 0,
      morphologicalExceptions: exceptionCount,
    },
  });

  return { manifest, sizes, outDir };
};

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).endsWith(join('dictionary', 'build.mjs'));

if (isMain) {
  const quiet = process.argv.includes('--quiet');
  const outDir = resolve(argument('--out') ?? join(projectRoot, 'resources', 'dictionary'));
  const log = quiet
    ? () => {}
    : (message) => {
        console.log(`[dictionary] ${message}`);
      };

  const started = Date.now();

  buildDictionary({ outDir, cacheDir: argument('--cache'), log }).then(
    ({ manifest, sizes }) => {
      console.log(
        JSON.stringify(
          {
            outDir,
            release: `${manifest.source.dataset} ${manifest.source.release}`,
            counts: manifest.counts,
            sizes,
            checksums: Object.fromEntries(manifest.files.map((file) => [file.name, file.sha256])),
            buildMilliseconds: Date.now() - started,
          },
          null,
          2,
        ),
      );
    },
    (error) => {
      console.error(`[dictionary] ${error.message}`);
      process.exit(1);
    },
  );
}
