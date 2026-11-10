import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the committed synthetic dictionary lives.
 *
 * Tests share one definition of this so that no test needs the real 29 MB
 * artifact, and so that moving the fixture is a one-line change.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const DICTIONARY_FIXTURE_DIR = resolve(here, '../fixtures/dictionary');

export const DICTIONARY_FIXTURE_SOURCE = resolve(here, '../fixtures/dictionary/source.json');

/** The files the fixture build writes, in the order the manifest lists them. */
export const DICTIONARY_FIXTURE_FILES = [
  'entries.jsonl',
  'entries.idx',
  'morphology.json',
  'manifest.json',
  'NOTICE.md',
] as const;
