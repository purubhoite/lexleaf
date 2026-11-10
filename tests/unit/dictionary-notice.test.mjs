import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { generateNotice, validateNotice, NOTICE_REQUIREMENTS } from '../../scripts/dictionary/lib/artifact.mjs';

const manifest = {
  source: { dataset: 'Open English WordNet', release: '2024', archiveUrl: 'https://en-word.net/downloads/english-wordnet-2024.zip', archiveSha256: 'pinned', },
  credits: ['Open English WordNet 2024'],
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modificationStatement: 'Modified for the application.',
  transformVersion: '1.0.0',
  files: [],
};
const upstream = `Open English WordNet 2024\nCC BY 4.0\nWordNet 3.1 Copyright 2011 by Princeton University.\nTHIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED.\nThe name of Princeton University or Princeton may not be used in advertising or publicity pertaining to distribution. Title to copyright in this software, database and any associated documentation shall at all times remain with Princeton University and LICENSEE agrees to preserve same.`;

it('generates and validates the complete notice independently of dictionary payloads', () => {
  const notice = generateNotice(manifest, upstream);
  assert.deepEqual(validateNotice(notice), { valid: true, missing: [] });
  assert.match(notice, /Pronunciation data: excluded/);
  assert.match(notice, /not affiliated with, sponsored by, or endorsed by Princeton University/);
});

it.each(NOTICE_REQUIREMENTS)('rejects a notice missing substantive requirement: %s', (requirement) => {
  const notice = generateNotice(manifest, upstream);
  const result = validateNotice(notice.replaceAll(requirement, ''));
  assert.equal(result.valid, false);
  assert.ok(result.missing.length > 0);
});

it('accepts upstream wording across line wrapping and whitespace', () => {
  const wrapped = generateNotice(manifest, upstream.replaceAll(' ', '  \n'));
  assert.deepEqual(validateNotice(wrapped), { valid: true, missing: [] });
});

it('keeps Apache application licensing separate from dictionary licensing', () => {
  const applicationNotice = readFileSync('NOTICE', 'utf8');
  assert.match(applicationNotice, /Apache License, Version 2\.0/);
  assert.match(applicationNotice, /does not apply to third-party.*dictionary data/s);
  const dictionaryNotice = generateNotice(manifest, upstream);
  assert.doesNotMatch(dictionaryNotice, /Apache License, Version 2\.0/);
});
