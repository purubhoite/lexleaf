#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import prettier from 'prettier';

const [base = 'FETCH_HEAD', head = 'HEAD'] = process.argv.slice(2);
const supported = /\.(?:c?js|mjs|json|md|ts|tsx|ya?ml)$/u;
const workflow = /^\.github\/workflows\/.*\.ya?ml$/u;

const changed = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter((file) => file.length > 0 && supported.test(file) && !workflow.test(file));

if (changed.length === 0) {
  throw new Error('no supported non-workflow files found for Prettier check');
}

const failures = [];
for (const file of changed) {
  const absolute = resolve(file);
  const info = await prettier.getFileInfo(absolute, { ignorePath: '.prettierignore' });
  if (info.ignored || info.inferredParser === null) continue;

  const source = readFileSync(absolute, 'utf8').replace(/\r\n/gu, '\n');
  const config = (await prettier.resolveConfig(absolute)) ?? {};
  const formatted = (
    await prettier.format(source, {
      ...config,
      filepath: absolute,
      endOfLine: 'lf',
    })
  ).replace(/\r\n/gu, '\n');
  if (source !== formatted) failures.push(file);
}

if (failures.length > 0) {
  console.error(`Prettier formatting failed for: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Prettier verified ${changed.length} changed non-workflow file(s).`);
}
