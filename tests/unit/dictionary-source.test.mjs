import assert from 'node:assert/strict';
import { it } from 'vitest';
import { archiveSources } from '../../scripts/dictionary/fetch-source.mjs';
import { loadSource } from '../../scripts/dictionary/fetch-source.mjs';

it('tries the project’s own dictionary URL first', async () => {
  const source = await loadSource();

  assert.deepEqual(archiveSources(source.archive)[0], source.archive.url);
  assert.match(source.archive.url, /^https:\/\/en-word\.net\//u);
});

it('offers only https mirrors of the same pinned archive', async () => {
  const source = await loadSource();
  const mirrors = source.archive.mirrors ?? [];

  assert.ok(mirrors.length > 0, 'the archive needs at least one mirror');
  for (const mirror of mirrors) {
    assert.match(mirror, /^https:\/\//u);
    assert.ok(!mirrors.includes(source.archive.url));
  }
});

it('pins the archive by size and checksum, which no mirror can change', async () => {
  const source = await loadSource();

  assert.equal(source.archive.bytes, 11457906);
  assert.equal(
    source.archive.sha256,
    '12ce54dd051b9420353f6c4ea74b34c736e23c8233d6d0bbd75407526f1fc732',
  );
});
