#!/usr/bin/env node
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const prettierCli = require.resolve('prettier/bin/prettier.cjs');
const [base = 'FETCH_HEAD', head = 'HEAD'] = process.argv.slice(2);
const supported = /\.(?:c?js|mjs|json|md|ts|tsx|ya?ml)$/u;
const workflow = /^\.github\/workflows\/.*\.ya?ml$/u;

const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', base, head], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter((file) => file.length > 0 && supported.test(file) && !workflow.test(file));

if (changed.length === 0) {
  throw new Error('no supported non-workflow files found for Prettier check');
}

const result = spawnSync(
  process.execPath,
  [prettierCli, '--check', '--end-of-line', 'lf', '--ignore-unknown', '--', ...changed],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
