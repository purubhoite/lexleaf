#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const dictionary = join(root, 'resources', 'dictionary');
const required = ['entries.jsonl', 'entries.idx', 'morphology.json', 'manifest.json', 'NOTICE.md'];
const manifest = JSON.parse(readFileSync(join(dictionary, 'manifest.json'), 'utf8'));
if (
  manifest.source?.dataset !== 'Open English WordNet' ||
  manifest.source?.release !== '2024' ||
  manifest.source?.tag !== '2024-edition' ||
  manifest.source?.commit !== '3c511bb'
)
  throw new Error('not the pinned OEWN 2024 production dictionary');
if (manifest.counts?.pronunciations !== 0 || !manifest.source?.pronunciationExcluded)
  throw new Error('pronunciation data is not excluded');
for (const name of required)
  if (!existsSync(join(dictionary, name))) throw new Error(`missing ${name}`);
const entries = readFileSync(join(dictionary, 'entries.jsonl'), 'utf8');
if (/"pr"\s*:/.test(entries)) throw new Error('embedded pronunciation field found');
for (const f of manifest.files) {
  const b = readFileSync(join(dictionary, f.name));
  const h = createHash('sha256').update(b).digest('hex');
  if (h !== f.sha256 || b.length !== f.bytes) throw new Error(`manifest mismatch ${f.name}`);
}
const notice = readFileSync(join(dictionary, 'NOTICE.md'), 'utf8');
for (const x of [
  'Open English WordNet 2024',
  'WordNet 3.1 Copyright 2011 by Princeton University',
  'CC BY 4.0',
  'does not imply Princeton endorsement',
])
  if (!notice.includes(x)) throw new Error(`notice missing ${x}`);
const result = {
  kind: 'authentic-oewn-2024-production',
  dictionary,
  counts: manifest.counts,
  files: manifest.files,
};
console.log(JSON.stringify(result, null, 2));
