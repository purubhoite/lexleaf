import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DICTIONARY_FIXTURE_DIR,
  DICTIONARY_FIXTURE_FILES,
} from '../../../tests/support/dictionaryFixture';

/**
 * The build is reproducible, and the committed fixture is what the build
 * produces.
 *
 * Both halves matter. If the transformation stopped being deterministic the
 * shipped artifact could no longer be verified by checksum; if the fixture
 * drifted from the writer, every test that uses it would be testing a
 * format nobody ships any more.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const script = join(root, 'scripts/dictionary/build-fixture.mjs');

const temporaries: string[] = [];

const buildInto = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dictionary-fixture-'));

  temporaries.push(directory);
  execFileSync(process.execPath, [script, '--out', directory], { cwd: root, stdio: 'pipe' });

  return directory;
};

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

afterAll(() => {
  for (const directory of temporaries) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('fixture artifact', () => {
  const first = buildInto();

  it('writes exactly the expected files', () => {
    expect(readdirSync(first).sort()).toEqual([...DICTIONARY_FIXTURE_FILES].sort());
  });

  it.each(DICTIONARY_FIXTURE_FILES)('rebuilds %s byte for byte', (name) => {
    expect(readFileSync(join(first, name))).toEqual(
      readFileSync(join(DICTIONARY_FIXTURE_DIR, name)),
    );
  });

  it('produces identical bytes when run twice', () => {
    const second = buildInto();

    for (const name of DICTIONARY_FIXTURE_FILES) {
      expect(sha256(join(second, name))).toBe(sha256(join(first, name)));
    }
  });

  it('records a checksum for every artifact file in the manifest', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(first, 'manifest.json'), 'utf8'));
    const files = (manifest as { files: { name: string; sha256: string; bytes: number }[] }).files;

    expect(files.map((file) => file.name).sort()).toEqual(
      ['entries.jsonl', 'entries.idx', 'morphology.json'].sort(),
    );

    for (const file of files) {
      expect(file.sha256).toBe(sha256(join(first, file.name)));
      expect(file.bytes).toBe(readFileSync(join(first, file.name)).byteLength);
    }
  });

  it('generates a notice that credits the source, states the modification and claims no legal review', () => {
    const notice = readFileSync(join(first, 'NOTICE.md'), 'utf8');

    expect(notice).toMatch(/Synthetic test dictionary fixture-1/u);
    expect(notice).toMatch(/### Licences/u);
    expect(notice).toMatch(/Modified: this fixture is entirely synthetic/u);
    expect(notice).toMatch(/Transform version: 1\.0\.0/u);
    expect(notice).toMatch(/No legal review of this redistribution has been carried out/u);

    // The notice is derived from the manifest, so every checksum it states
    // is the checksum the manifest recorded.
    for (const line of notice.split('\n').filter((text) => text.startsWith('- `'))) {
      expect(line).toMatch(/SHA-256 `[0-9a-f]{64}`/u);
    }
  });
});
