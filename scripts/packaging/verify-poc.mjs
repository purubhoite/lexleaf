#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const resources = join(root, 'packaging', 'poc');
const dictionary = join(resources, 'dictionary');
const required = ['entries.jsonl', 'entries.idx', 'morphology.json', 'manifest.json', 'NOTICE.md'];
const manifest = JSON.parse(readFileSync(join(dictionary, 'manifest.json'), 'utf8'));
const files = Object.fromEntries(manifest.files.map((x) => [x.name, x]));
const checks = required.map((name) => {
  const p = join(dictionary, name);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  const b = readFileSync(p);
  return {
    name,
    bytes: b.length,
    sha256: createHash('sha256').update(b).digest('hex'),
    manifest: files[name]?.sha256 ?? null,
  };
});
for (const x of checks)
  if (
    x.name !== 'NOTICE.md' &&
    x.name !== 'manifest.json' &&
    (x.sha256 !== x.manifest || x.bytes !== files[x.name].bytes)
  )
    throw new Error(`manifest mismatch ${x.name}`);
const result = {
  kind: 'internal-poc-assets',
  dictionary,
  counts: manifest.counts,
  files: checks,
  notices: readdirSync(join(resources, 'notices')).sort(),
};
console.log(JSON.stringify(result, null, 2));
