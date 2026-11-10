/**
 * The shape of everything the application remembers between launches.
 *
 * Deliberately small and flat: Milestone 2 needed where the reader was and
 * which documents were read recently, and 6.8 adds the four preferences of
 * ADR-031 beside them — nothing else. The structure is a plain value so
 * that every operation on it can be a pure function (ADR-016).
 *
 * `Preferences` is a type-only import: the parsing lives in
 * `preferences.ts`, which reads `ZoomState` from here, and keeping the
 * dependency one-directional at runtime keeps that from becoming a cycle.
 */

import type { Preferences } from './preferences';

/** How the reader is sizing pages. */
export type ZoomMode = 'fixed' | 'fit-width' | 'fit-page';

export interface ZoomState {
  readonly mode: ZoomMode;
  /** Last resolved scale; 1 means 100 %. Meaningful for `fixed`, a hint otherwise. */
  readonly scale: number;
}

/**
 * Where a reader stopped.
 *
 * The offset is a fraction of the page's own height rather than a pixel
 * value, so a position recorded at 200 % still restores correctly at 75 % and
 * after a window resize.
 */
export interface ReadingPosition {
  readonly page: number;
  /** 0 = top of that page, 1 = bottom of it. */
  readonly pageOffsetFraction: number;
  readonly zoom: ZoomState;
}

/** One document the application has opened. */
export interface DocumentRecord {
  /** Content-derived identity; see `documentIdentity.ts` in the main process. */
  readonly id: string;
  /** Absolute path. Never leaves the main process (ADR-016). */
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** Known only once the document has been opened successfully. */
  readonly pageCount: number | null;
  readonly position: ReadingPosition;
  /** ISO 8601 timestamp of the most recent successful open. */
  readonly lastOpenedAt: string;
}

export interface ReaderState {
  readonly schemaVersion: number;
  /** Most recently used first. */
  readonly documents: readonly DocumentRecord[];
  /**
   * The four settings (ADR-031, schema v2).
   *
   * Always present in memory, always one of the enumerated values: a
   * document read from disk without the block, or with a malformed one,
   * is given the defaults rather than rejected.
   */
  readonly preferences: Preferences;
}

export const DEFAULT_ZOOM: ZoomState = { mode: 'fit-width', scale: 1 };

export const START_OF_DOCUMENT: ReadingPosition = {
  page: 1,
  pageOffsetFraction: 0,
  zoom: DEFAULT_ZOOM,
};
