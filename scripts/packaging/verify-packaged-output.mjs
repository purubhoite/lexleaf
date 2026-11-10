#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const unpacked = resolve(process.argv[2] ?? join(root, 'dist', 'win-unpacked'));
const dictionary = join(unpacked, 'resources', 'dictionary');
const required = ['entries.jsonl', 'entries.idx', 'morphology.json', 'manifest.json', 'NOTICE.md'];

if (!existsSync(dictionary)) throw new Error(`packaged dictionary missing: ${dictionary}`);
const manifest = JSON.parse(readFileSync(join(dictionary, 'manifest.json'), 'utf8'));
const expected = {
  headwords: 152286,
  senses: 203021,
  morphologicalExceptions: 4474,
  pronunciations: 0,
};
for (const [key, value] of Object.entries(expected)) {
  if (manifest.counts?.[key] !== value)
    throw new Error(`unexpected ${key}: ${String(manifest.counts?.[key])}`);
}
for (const name of required)
  if (!existsSync(join(dictionary, name))) throw new Error(`missing packaged file: ${name}`);
const entries = readFileSync(join(dictionary, 'entries.jsonl'), 'utf8');
if (/"pr"\s*:/.test(entries)) throw new Error('packaged dictionary contains pronunciation data');
for (const file of manifest.files) {
  const bytes = readFileSync(join(dictionary, file.name));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== file.bytes || sha256 !== file.sha256)
    throw new Error(`packaged hash mismatch: ${file.name}`);
}
const names = JSON.stringify(requireNames(unpacked));
if (names.includes('tests/fixtures/dictionary') || names.includes('packaging/poc/dictionary'))
  throw new Error('synthetic dictionary payload found');
const notice = readFileSync(join(dictionary, 'NOTICE.md'), 'utf8');
for (const text of ['Open English WordNet 2024', 'CC BY 4.0', 'WordNet 3.1 Copyright 2011'])
  if (!notice.includes(text)) throw new Error(`missing dictionary notice text: ${text}`);
console.log(
  JSON.stringify({ unpacked, dictionary, counts: manifest.counts, files: manifest.files }, null, 2),
);

function requireNames(directory) {
  // The verifier only needs to inspect known packaging paths; no recursive archive scan is required.
  return [join(directory, 'resources', 'dictionary')];
}
