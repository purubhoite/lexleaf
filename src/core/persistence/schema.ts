import { DEFAULT_PREFERENCES, parsePreferences } from './preferences';
import { CURRENT_SCHEMA_VERSION, emptyReaderState } from './readerState';
import {
  DEFAULT_ZOOM,
  type DocumentRecord,
  type ReaderState,
  type ReadingPosition,
  type ZoomMode,
  type ZoomState,
} from './types';

/**
 * Reading the stored state back.
 *
 * Stored data is input, not memory: a file on disk can be truncated by a
 * crash, edited by a user, or written by a newer version of the application.
 * It is therefore parsed field by field, and anything unrecognisable is
 * discarded rather than repaired by guesswork (ADR-016).
 */

/** Why the stored state was not used as-is. */
export type RecoveryReason =
  'unreadable-json' | 'not-an-object' | 'unknown-schema-version' | 'future-schema-version';

export interface ParsedReaderState {
  readonly state: ReaderState;
  /**
   * Set when the stored document could not be used. The caller quarantines
   * the file instead of silently overwriting the user's history.
   */
  readonly recoveredFrom: RecoveryReason | null;
  /** Records that were dropped individually because their shape was wrong. */
  readonly droppedRecords: number;
}

/**
 * Migrations from an older schema version to the next one.
 *
 * One entry, and it is deliberately the smallest thing a migration can be
 * (ADR-031): a version-1 document is given the default preferences and
 * nothing else about it is touched. No reading position is rewritten, no
 * recent entry is reordered or dropped, and no identity changes — the only
 * difference between the document that went in and the one that comes out
 * is a block that was not there before.
 *
 * A `preferences` block inside a document that still calls itself version 1
 * is ignored rather than adopted: the version is the file's own statement
 * about its shape, and believing a field the version does not promise is
 * how a half-migrated document becomes indistinguishable from a migrated
 * one.
 */
const MIGRATIONS: Readonly<Record<number, (document: ReaderState) => ReaderState>> = {
  1: (document) => ({ ...document, schemaVersion: 2, preferences: DEFAULT_PREFERENCES }),
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const ZOOM_MODES: readonly ZoomMode[] = ['fixed', 'fit-width', 'fit-page'];

const parseZoom = (value: unknown): ZoomState => {
  if (!isObject(value)) {
    return DEFAULT_ZOOM;
  }

  const mode = ZOOM_MODES.find((candidate) => candidate === value['mode']);
  const scale = asFiniteNumber(value['scale']);

  if (mode === undefined || scale === null || scale <= 0) {
    return DEFAULT_ZOOM;
  }

  return { mode, scale };
};

const parsePosition = (value: unknown): ReadingPosition => {
  const zoom = isObject(value) ? parseZoom(value['zoom']) : DEFAULT_ZOOM;

  if (!isObject(value)) {
    return { page: 1, pageOffsetFraction: 0, zoom };
  }

  const page = asFiniteNumber(value['page']);
  const fraction = asFiniteNumber(value['pageOffsetFraction']);

  return {
    page: page === null || page < 1 ? 1 : Math.floor(page),
    pageOffsetFraction: fraction === null ? 0 : Math.min(Math.max(fraction, 0), 1),
    zoom,
  };
};

const parseRecord = (value: unknown): DocumentRecord | null => {
  if (!isObject(value)) {
    return null;
  }

  const id = asString(value['id']);
  const path = asString(value['path']);
  const name = asString(value['name']);
  const lastOpenedAt = asString(value['lastOpenedAt']);
  const sizeBytes = asFiniteNumber(value['sizeBytes']);
  const pageCount = asFiniteNumber(value['pageCount']);

  // A record without identity, path or name cannot be reopened, so it is not
  // a record at all.
  if (id === null || path === null || name === null || lastOpenedAt === null) {
    return null;
  }

  return {
    id,
    path,
    name,
    sizeBytes: sizeBytes ?? 0,
    pageCount: pageCount === null || pageCount < 1 ? null : Math.floor(pageCount),
    position: parsePosition(value['position']),
    lastOpenedAt,
  };
};

const applyMigrations = (state: ReaderState): ReaderState | null => {
  let migrated = state;

  while (migrated.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[migrated.schemaVersion];

    if (migrate === undefined) {
      return null;
    }

    migrated = migrate(migrated);
  }

  return migrated;
};

const recovered = (reason: RecoveryReason): ParsedReaderState => ({
  state: emptyReaderState(),
  recoveredFrom: reason,
  droppedRecords: 0,
});

/** Parses the contents of the state file. */
export const parseReaderState = (serialized: string): ParsedReaderState => {
  let value: unknown;

  try {
    value = JSON.parse(serialized);
  } catch {
    return recovered('unreadable-json');
  }

  if (!isObject(value)) {
    return recovered('not-an-object');
  }

  const schemaVersion = asFiniteNumber(value['schemaVersion']);

  if (schemaVersion === null || schemaVersion < 1) {
    return recovered('unknown-schema-version');
  }

  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    // Written by a newer build. Guessing at its meaning risks destroying it.
    return recovered('future-schema-version');
  }

  const rawRecords = Array.isArray(value['documents']) ? value['documents'] : [];
  const documents = rawRecords
    .map(parseRecord)
    .filter((record): record is DocumentRecord => record !== null);

  /*
   * The preferences block is repaired rather than rejected: a malformed,
   * absent or hostile block produces the four defaults, and is never a
   * reason to quarantine a file (ADR-031). Quarantine stays reserved for
   * a document that cannot be understood at all — unreadable JSON, a
   * non-object, a version from the future.
   *
   * Whether this block is *believed* is the migration's decision, not
   * this line's: a document that calls itself version 1 is given the
   * defaults below, because the version is the file's own statement
   * about its shape and a field it does not promise is not evidence.
   */
  const preferences = parsePreferences(value['preferences']);
  const migrated = applyMigrations({ schemaVersion, documents, preferences });

  if (migrated === null) {
    return recovered('unknown-schema-version');
  }

  return {
    state: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      documents: migrated.documents,
      preferences: migrated.preferences,
    },
    recoveredFrom: null,
    droppedRecords: rawRecords.length - documents.length,
  };
};

/**
 * Writes the document back.
 *
 * The preferences are re-parsed on the way out as well as on the way in.
 * The in-memory value is typed, but a type is not a guarantee at the edge
 * of a process, and this is the one function that decides what is actually
 * stored: re-parsing here is what makes "the file can only ever contain one
 * of the enumerated values" true rather than intended. It also keeps the
 * block to exactly the four known keys — a field the application does not
 * know about cannot be round-tripped into the document.
 */
export const serializeReaderState = (state: ReaderState): string =>
  `${JSON.stringify(
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      documents: state.documents,
      preferences: parsePreferences(state.preferences),
    },
    null,
    2,
  )}\n`;
