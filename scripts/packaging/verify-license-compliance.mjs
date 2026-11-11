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
