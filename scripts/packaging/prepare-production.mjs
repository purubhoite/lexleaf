#!/usr/bin/env node
/** Prepare the verified, generated production dictionary for packaging. */
import { spawnSync } from 'node:child_process';

const run = (label, args) => {
  console.log(`[packaging] ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed with status ${String(result.status)}`);
};

run('fetch and verify pinned OEWN source', ['scripts/dictionary/fetch-source.mjs']);
run('build production dictionary', ['scripts/dictionary/build.mjs', '--quiet']);
run('verify reproducibility', ['scripts/dictionary/verify-reproducible.mjs']);
run('verify production artifact', ['scripts/packaging/verify-production-dictionary.mjs']);
