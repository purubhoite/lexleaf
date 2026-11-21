#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const source = JSON.parse(readFileSync(join(root, 'scripts/dictionary/source.json'), 'utf8'));
if (source.dataset !== 'Open English WordNet' || source.release !== '2024')
  throw new Error('unexpected dictionary source');
if (source.archive.sha256 !== '12ce54dd051b9420353f6c4ea74b34c736e23c8233d6d0bbd75407526f1fc732')
  throw new Error('unexpected dictionary archive checksum');
if (source.commit !== '3c511bb') throw new Error('unexpected dictionary source commit');
const requiredLicences = [
  'https://creativecommons.org/licenses/by/4.0/',
  'https://wordnet.princeton.edu/license-and-commercial-use',
];
for (const url of requiredLicences) {
  if (!source.licences.some((licence) => licence.url === url))
    throw new Error(`missing license source: ${url}`);
}
const noticePath = join(root, 'resources/dictionary/NOTICE.md');
if (!existsSync(noticePath)) throw new Error('generated dictionary notice is missing');
const notice = readFileSync(noticePath, 'utf8').replace(/\s+/gu, ' ');
for (const text of [
  'Open English WordNet 2024',
  'WordNet 3.1 Copyright 2011 by Princeton University',
  'CC BY 4.0',
  'THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS"',
  'MAKES NO REPRESENTATIONS OR WARRANTIES',
  'The name of Princeton University or Princeton may not be used in',
  'not affiliated with, sponsored by, or endorsed by Princeton University.',
]) {
  if (!notice.includes(text.replace(/\s+/gu, ' '))) throw new Error(`notice missing: ${text}`);
}
console.log('Dictionary license compliance verified.');

/**
 * The licence must travel with the binary.
 *
 * Apache-2.0 §4(a) requires a copy of the License to reach every recipient
 * of the software, and §4(d) requires the NOTICE file to accompany it. The
 * repository is not the distribution: `electron-builder.yml`'s `files:` list
 * decides what is inside the installer. Until 0.2.11 it listed only the
 * build output and `package.json`, so an installed Lexleaf carried neither.
 *
 * This is a static check of the packaging configuration on purpose: it runs
 * in every job, needs no build, and fails the moment someone narrows the
 * list again.
 */
// Three configurations build three products: Windows, Linux and Mac. Each
// has its own `files:` list, so each is checked — a fix applied to one and
// forgotten in the others ships a licence-free installer to two thirds of
// the readers.
const BUILDER_CONFIGS = ['electron-builder.yml', 'linux-builder.yml', 'mac-builder.yml'];

for (const config of BUILDER_CONFIGS) {
  const builderConfig = readFileSync(join(root, config), 'utf8');
  const filesList = /^files:\n((?:[ \t]+- .*\n)+)/mu.exec(builderConfig);

  if (filesList === null) throw new Error(`${config} has no files: list to inspect`);

  const shipped = filesList[1]
    .split('\n')
    .map((line) => line.replace(/^[ \t]+- /u, '').trim())
    .filter((line) => line !== '');

  for (const required of ['LICENSE', 'NOTICE']) {
    if (!shipped.includes(required))
      throw new Error(`${required} is not shipped inside the installer (${config} files:)`);
  }
}

// And the files themselves must be there to be shipped.
for (const required of ['LICENSE', 'NOTICE']) {
  if (!existsSync(join(root, required)))
    throw new Error(`${required} is missing from the repository`);
}

console.log('Licence and notices are shipped with the application.');
