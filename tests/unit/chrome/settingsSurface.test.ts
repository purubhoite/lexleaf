import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  PREFERENCE_KEYS,
  PREFERENCE_VALUES,
  parsePreferences,
} from '@core/persistence/preferences';

import { stripComments } from '../styles/stylesheetSource';

/**
 * What the settings surface cannot contain (ADR-031).
 *
 * The milestone's privacy claim is a claim about absence: the settings
 * surface cannot persist or transmit a credential, a provider address or
 * a path, because it has no control capable of expressing one. Absence is
 * not observable by rendering — a field no test renders still ships — so
 * it is asserted against the source.
 *
 * The scope is deliberately the settings surface alone. The application's
 * PDF password prompt is a document-opening control, not a setting, and
 * is untouched by this milestone: a repository-wide ban on
 * `type="password"` would have deleted a feature readers need.
 */

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const read = (...parts: readonly string[]): string =>
  readFileSync(join(REPOSITORY_ROOT, ...parts), 'utf8');

const SETTINGS = ['src', 'renderer', 'src', 'settings'] as const;

const panel = read(...SETTINGS, 'SettingsPanel.tsx');
const hook = read(...SETTINGS, 'usePreferences.ts');
const preferences = read('src', 'core', 'persistence', 'preferences.ts');

/** The surface's own code, with the prose that explains it removed. */
const code = {
  panel: stripComments(panel),
  hook: stripComments(hook),
  preferences: stripComments(preferences),
};

/** Words that would each be a different milestone, and a different ADR. */
const FORBIDDEN = [
  'password',
  'apikey',
  'api_key',
  'secret',
  'token',
  'credential',
  'endpoint',
  'provider',
  'http://',
  'https://',
  'localhost',
  'telemetry',
  'account',
  'subscription',
  'license',
  'licence',
] as const;

describe('the settings panel’s controls', () => {
  it('offers radio buttons and one button, and nothing else', () => {
    expect([...new Set([...code.panel.matchAll(/type="([a-z]+)"/gu)].map((m) => m[1]))]).toEqual([
      'radio',
      'button',
    ]);
  });

  it('has no password, text, file or other free-entry field', () => {
    for (const type of ['password', 'text', 'url', 'email', 'number', 'file', 'search', 'tel']) {
      expect(panel).not.toContain(`type="${type}"`);
    }

    for (const element of ['<textarea', '<select', '<form', 'contentEditable']) {
      expect(code.panel).not.toContain(element);
    }
  });

  it('names no credential, address or commercial concept', () => {
    for (const word of FORBIDDEN) {
      expect(code.panel.toLowerCase()).not.toContain(word);
      expect(code.hook.toLowerCase()).not.toContain(word);
    }
  });
});

describe('what the settings surface can send and store', () => {
  it('reaches the main process through one channel and no other', () => {
    const calls = [...code.hook.matchAll(/bridge[?.]*\.([a-zA-Z]+)\(/gu)].map((match) => match[1]);

    expect([...new Set(calls)].sort()).toStrictEqual(['getReaderState', 'savePreferences']);
  });

  it('makes no network call of its own', () => {
    for (const source of [code.panel, code.hook, code.preferences]) {
      expect(source).not.toMatch(/\bfetch\s*\(/u);
      expect(source).not.toContain('XMLHttpRequest');
      expect(source).not.toContain('WebSocket');
      expect(source).not.toContain('navigator.sendBeacon');
    }
  });

  it('touches no Node API and no file system', () => {
    for (const source of [code.panel, code.hook]) {
      expect(source).not.toContain('node:');
      expect(source).not.toContain('require(');
      expect(source).not.toContain('process.');
      expect(source).not.toContain('fs.');
      expect(source).not.toContain('ipcRenderer');
    }
  });

  it('asks the system nothing the cascade already answers', () => {
    // ADR-030 and ADR-032: one mechanism each, and neither is matchMedia.
    for (const source of [code.panel, code.hook]) {
      expect(source).not.toContain('matchMedia');
      expect(source).not.toContain('prefers-color-scheme');
      expect(source).not.toContain('prefers-reduced-motion');
      expect(source).not.toContain('nativeTheme');
    }
  });

  it('writes the two document attributes through the existing writers', () => {
    expect(code.hook).toContain('applyAppearance(document.documentElement');
    expect(code.hook).toContain('applyMotion(document.documentElement');
    expect(code.hook).not.toContain("setAttribute('data-theme'");
    expect(code.hook).not.toContain("setAttribute('data-motion'");
  });

  /*
   * The assertion this replaces extracted every `'[a-z-]+'` literal from
   * `preferences.ts` and then asserted that each extracted string matched
   * `^[a-z-]+$`. It could not fail: the pattern that found the values was
   * the pattern they were checked against, so adding `password: string`
   * to the preferences would have left it green. These four take the
   * claim it was gesturing at — "no secret can reach the disk" — and
   * check it against the module that actually writes the disk.
   */

  it('has an alphabet that is exactly the four ADR-031 fields and their values', () => {
    expect(PREFERENCE_VALUES).toStrictEqual({
      appearance: ['system', 'light', 'dark'],
      reduceMotion: ['system', 'always'],
      defaultZoomMode: ['fit-width', 'fit-page', 'last-used'],
      showDeveloperDiagnostics: ['off', 'on'],
    });

    expect(Object.keys(PREFERENCE_VALUES)).toStrictEqual([...PREFERENCE_KEYS]);
  });

  it('defaults to the values the milestone shipped, which are all in the alphabet', () => {
    expect(DEFAULT_PREFERENCES).toStrictEqual({
      appearance: 'system',
      reduceMotion: 'system',
      defaultZoomMode: 'fit-width',
      showDeveloperDiagnostics: 'off',
    });

    for (const key of PREFERENCE_KEYS) {
      expect(PREFERENCE_VALUES[key]).toContain(DEFAULT_PREFERENCES[key]);
    }
  });

  it('turns anything a reader could type into an enumerated value, and keeps nothing else', () => {
    // Every field carries something a settings surface must never store,
    // plus three keys that are not preferences at all.
    const stored = parsePreferences({
      appearance: 'https://provider.example/v1/chat/completions',
      reduceMotion: 'sk-live-9f3a2b7c41e84d05',
      defaultZoomMode: '/home/reader/Documents/Tax Return 2025.pdf',
      showDeveloperDiagnostics: { valueOf: () => 'on' },
      apiKey: 'sk-live-9f3a2b7c41e84d05',
      endpoint: 'http://127.0.0.1:11434',
      password: 'hunter2',
    });

    expect(Object.keys(stored)).toStrictEqual([...PREFERENCE_KEYS]);
    expect(stored).toStrictEqual(DEFAULT_PREFERENCES);

    const written = JSON.stringify(stored);

    for (const secret of ['sk-live', 'http', '://', '/home/', 'hunter2', 'apiKey', 'endpoint']) {
      expect(written).not.toContain(secret);
    }

    for (const key of PREFERENCE_KEYS) {
      expect(PREFERENCE_VALUES[key]).toContain(stored[key]);
    }
  });

  it('offers in the panel exactly the alphabet, each value once and no other', () => {
    const offered = [...code.panel.matchAll(/value:\s*'([^']*)'/gu)].map((match) => match[1] ?? '');
    const approved = PREFERENCE_KEYS.flatMap((key) => [...PREFERENCE_VALUES[key]]);

    expect([...offered].sort()).toStrictEqual([...approved].sort());
  });
});
