import { parseAppearance, DEFAULT_APPEARANCE, type Appearance } from './appearance';
import { parseReduceMotion, DEFAULT_REDUCE_MOTION, type ReduceMotion } from './motion';
import { DEFAULT_ZOOM, type ZoomState } from './types';

/**
 * The four preferences, and the whole of what a preference may be.
 *
 * ADR-031 defines a setting as *a preference with no security surface, no
 * network effect and no destructive consequence*, and closes the list at
 * four. This module is that list, expressed once: the field names here are
 * the field names in the reader-state document, in the IPC payload and in
 * the settings panel, because a preference that is called three things is a
 * preference that will eventually be stored twice.
 *
 * Three properties hold for every field, and they are the reason parsing
 * lives in `core` rather than at either process boundary:
 *
 * - **per-field fallback.** An unknown, missing, misspelled or wrongly
 *   typed value becomes that field's default. It never invalidates another
 *   field, never invalidates the document list, and never throws. A
 *   preference may not be a reason the application does not start;
 * - **closed vocabularies.** Every value is one of a small enumerated set.
 *   Nothing here accepts free text, and there is no field that could carry
 *   a path, a URL, an endpoint, a credential, a document name or anything a
 *   reader typed — see `PREFERENCE_VALUES` below, which is the whole
 *   alphabet this subsystem can write to disk;
 * - **no secrets by construction.** The deferred settings of ADR-031
 *   (provider endpoint, model, credentials) are absent, not disabled.
 */

/** Which fit a document with no remembered position opens at. */
export type DefaultZoomMode = 'fit-width' | 'fit-page' | 'last-used';

/** Whether the existing diagnostics disclosure starts expanded. */
export type DeveloperDiagnosticsPreference = 'on' | 'off';

export interface Preferences {
  /** ADR-030. Resolved to `data-theme` in the renderer and to the window background in main. */
  readonly appearance: Appearance;
  /** ADR-032. Resolved to `data-motion` in the renderer. The canonical stored name. */
  readonly reduceMotion: ReduceMotion;
  /** ADR-031. Applies only to a document with no stored reading position. */
  readonly defaultZoomMode: DefaultZoomMode;
  /** ADR-031. Opens the existing disclosure; adds and removes no information. */
  readonly showDeveloperDiagnostics: DeveloperDiagnosticsPreference;
}

export const DEFAULT_ZOOM_MODES: readonly DefaultZoomMode[] = [
  'fit-width',
  'fit-page',
  'last-used',
];

export const DEVELOPER_DIAGNOSTICS_VALUES: readonly DeveloperDiagnosticsPreference[] = [
  'off',
  'on',
];

/**
 * Every preference, with the default ADR-031 names for it.
 *
 * `fit-width` is today's `DEFAULT_ZOOM.mode`, so the default preference
 * reproduces the behaviour that shipped before this preference existed;
 * `off` keeps the diagnostics disclosure closed, which is the 6.4 design.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  appearance: DEFAULT_APPEARANCE,
  reduceMotion: DEFAULT_REDUCE_MOTION,
  defaultZoomMode: 'fit-width',
  showDeveloperDiagnostics: 'off',
};

/** The field names, in the order the settings panel shows them. */
export const PREFERENCE_KEYS = [
  'appearance',
  'reduceMotion',
  'defaultZoomMode',
  'showDeveloperDiagnostics',
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/**
 * Every value any preference may take.
 *
 * Written out so that a test can assert the whole alphabet: these eleven
 * strings are the only thing the preferences subsystem is capable of
 * writing to disk or sending over IPC, which is what makes the "no secret,
 * no URL, no path, no document content" rule a property of the type rather
 * than a promise in a document.
 */
export const PREFERENCE_VALUES: Readonly<Record<PreferenceKey, readonly string[]>> = {
  appearance: ['system', 'light', 'dark'],
  reduceMotion: ['system', 'always'],
  defaultZoomMode: ['fit-width', 'fit-page', 'last-used'],
  showDeveloperDiagnostics: ['off', 'on'],
};

const parseDefaultZoomMode = (value: unknown): DefaultZoomMode =>
  DEFAULT_ZOOM_MODES.find((candidate) => candidate === value) ??
  DEFAULT_PREFERENCES.defaultZoomMode;

const parseDeveloperDiagnostics = (value: unknown): DeveloperDiagnosticsPreference =>
  DEVELOPER_DIAGNOSTICS_VALUES.find((candidate) => candidate === value) ??
  DEFAULT_PREFERENCES.showDeveloperDiagnostics;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the four preferences out of unvalidated input.
 *
 * The input is anything: a block from a file edited by hand, a payload from
 * the renderer, a value written by a newer build. Nothing it can contain
 * produces an exception, and nothing it can contain survives into the
 * result except one of the enumerated values above — extra keys are
 * dropped rather than carried, because a preference the application does
 * not know about is not a preference it should store.
 */
export const parsePreferences = (value: unknown): Preferences => {
  const source = isObject(value) ? value : {};

  return {
    appearance: parseAppearance(source['appearance']),
    reduceMotion: parseReduceMotion(source['reduceMotion']),
    defaultZoomMode: parseDefaultZoomMode(source['defaultZoomMode']),
    showDeveloperDiagnostics: parseDeveloperDiagnostics(source['showDeveloperDiagnostics']),
  };
};

/**
 * The zoom a document with no remembered position opens at.
 *
 * `last-used` is answered by the zoom the reader was last reading at — the
 * one on the most recently opened document, which is a fact the reader
 * state already holds, not a new stored value. With nothing to go on it
 * falls back to the same default as everything else.
 *
 * A remembered position still wins over all three: this function is only
 * consulted when there is none (ADR-016, ADR-031).
 */
export const resolveDefaultZoom = (
  mode: DefaultZoomMode,
  lastUsed: ZoomState | null,
): ZoomState => {
  switch (mode) {
    case 'fit-width':
      return { mode: 'fit-width', scale: DEFAULT_ZOOM.scale };
    case 'fit-page':
      return { mode: 'fit-page', scale: DEFAULT_ZOOM.scale };
    case 'last-used':
      return lastUsed ?? DEFAULT_ZOOM;
  }
};
