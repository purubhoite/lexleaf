import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Core must never reach the network, and this asserts it.
 *
 * The explanation feature is the first part of the application that talks
 * to anything outside the machine, so the line between "the rules of the
 * feature" and "the code that performs a request" has to be visible and
 * enforced. `src/core/ai` holds types, the prompt builder, the response
 * parser and the identity rule. It does not perform I/O, and ESLint's
 * boundary rules do not ban `node:*` in core — so this static scan does.
 *
 * Mirrors `src/main/dictionary/dictionaryNetworkPolicy.test.ts`; it catches
 * the realistic ways network code arrives rather than proving a negative.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch', /\bfetch\s*\(/u],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['WebSocket', /\bWebSocket\b/u],
  ['EventSource', /\bEventSource\b/u],
  ['navigator.sendBeacon', /\bsendBeacon\b/u],
  ['node:http', /['"]node:https?['"]/u],
  ['node:net', /['"]node:(net|dgram|tls|dns)['"]/u],
  ['node:fs', /['"]node:fs(\/promises)?['"]/u],
  ['node:crypto', /['"]node:crypto['"]/u],
  ['electron', /from\s+['"]electron['"]/u],
  ['a bare http url', /https?:\/\//u],
  ['an api key', /\b(api[_-]?key|authorization|bearer)\b/iu],
];

const files = readdirSync(join(root, 'src/core/ai'), { withFileTypes: true, recursive: true })
  .filter(
    (item) => item.isFile() && /\.tsx?$/u.test(item.name) && !/\.test\.tsx?$/u.test(item.name),
  )
  .map((item) => join(item.parentPath, item.name));

describe('the AI core does not reach the network', () => {
  it('scans every file in the subsystem', () => {
    expect(files.map((file) => relative(root, file).split(sep).join('/')).sort()).toEqual([
      'src/core/ai/identity.ts',
      'src/core/ai/limits.ts',
      'src/core/ai/parseResponse.ts',
      'src/core/ai/prompt.ts',
      'src/core/ai/types.ts',
    ]);
  });

  it.each(FORBIDDEN)('contains no %s', (_name, pattern) => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      // Prose in a comment is not an API call; strip comments first.
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

      return pattern.test(code);
    });

    expect(offenders.map((file) => relative(root, file).split(sep).join('/'))).toEqual([]);
  });

  it('imports nothing but application types', () => {
    const allowed = /^(@core\/|@shared\/|\.{1,2}\/)/u;

    const imports = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => ({
        file: relative(root, file).split(sep).join('/'),
        specifier: match[1] ?? '',
      })),
    );

    expect(imports.filter((entry) => !allowed.test(entry.specifier))).toEqual([]);
  });

  it('names no vendor in the port', () => {
    const port = readFileSync(join(root, 'src/core/ai/types.ts'), 'utf8');

    for (const vendor of ['openai', 'anthropic', 'gemini', 'ollama', 'llama', 'mistral']) {
      expect(port.toLowerCase()).not.toContain(vendor);
    }
  });
});
