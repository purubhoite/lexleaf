import type { DatabaseSync } from 'node:sqlite';

/**
 * The vocabulary schema, and the only place it is written down.
 *
 * Integration tests build their databases by calling `migrate` here rather
 * than by pasting DDL into a fixture, so a test can never pass against a
 * schema the application does not ship (ADR-021).
 *
 * Migration rules, all enforced below:
 *
 * - **`PRAGMA user_version` is the version**, nothing else. No framework, no
 *   table of applied migrations.
 * - **Forward only.** A database written by a newer build is left untouched
 *   and reported as `schema-too-new`; downgrading a reader's saved words by
 *   guesswork is worse than refusing to open.
 * - **One transaction per step.** A step that throws is rolled back whole,
 *   and the version stays where it was.
 */

/** The schema version this build writes and understands. */
export const CURRENT_SCHEMA_VERSION = 2;

const VERSION_1 = `
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  last_known_path TEXT,
  page_count      INTEGER,
  size_bytes      INTEGER,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE TABLE dictionary_sources (
  id                INTEGER PRIMARY KEY,
  provider          TEXT NOT NULL,
  dataset_name      TEXT NOT NULL,
  dataset_release   TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  attribution_json  TEXT NOT NULL,
  first_seen_at     TEXT NOT NULL,
  UNIQUE (provider, dataset_release, transform_version)
);

CREATE TABLE vocabulary_items (
  id                  TEXT PRIMARY KEY,
  normalized_word     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_word        TEXT NOT NULL COLLATE NOCASE,
  raw_word            TEXT NOT NULL,
  joined_across_lines INTEGER NOT NULL DEFAULT 0,
  headword            TEXT COLLATE NOCASE,
  resolved_by         TEXT,
  lookup_status       TEXT NOT NULL,
  short_definition    TEXT,
  snapshot_json       TEXT,
  source_id           INTEGER REFERENCES dictionary_sources(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE vocabulary_occurrences (
  id                   INTEGER PRIMARY KEY,
  item_id              TEXT NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  document_id          TEXT NOT NULL REFERENCES documents(id),
  page                 INTEGER NOT NULL CHECK (page >= 1),
  char_start           INTEGER,
  char_end             INTEGER,
  page_offset_fraction REAL,
  context              TEXT CHECK (context IS NULL OR length(context) <= 240),
  context_word_start   INTEGER,
  created_at           TEXT NOT NULL,
  CHECK ((char_start IS NULL AND char_end IS NULL)
         OR (char_start IS NOT NULL AND char_end IS NOT NULL
             AND char_start >= 0 AND char_end > char_start)),
  UNIQUE (item_id, document_id, page)
);

CREATE INDEX idx_items_created     ON vocabulary_items (created_at DESC);
CREATE INDEX idx_items_display     ON vocabulary_items (display_word);
CREATE INDEX idx_items_headword    ON vocabulary_items (headword);
CREATE INDEX idx_occ_document_page ON vocabulary_occurrences (document_id, page);
CREATE INDEX idx_occ_document_item ON vocabulary_occurrences (document_id, item_id);
`;

/**
 * Version 2: contextual explanations (Milestone 5).
 *
 * Additive only — it creates one table and one index and touches nothing
 * that exists, so `rewritesData` is false and no backup is warranted.
 *
 * Why the shape is what it is:
 *
 * - **Not in `snapshot_json`.** The snapshot is the immutable record of
 *   what the *dictionary* showed (ADR-025); model output in it would
 *   destroy that meaning. A separate table also means explanations can be
 *   dropped wholesale without touching a single saved word.
 * - **Per occurrence, not per item.** `(item_id, document_id, page)` is
 *   M4's occurrence identity, reused verbatim, because "charge" on page 10
 *   and page 84 are different questions. The columns are duplicated rather
 *   than referencing `vocabulary_occurrences.id` so that a word explained
 *   before it was saved can be promoted into a row later.
 * - **`UNIQUE` over the whole identity tuple.** The seven dimensions of
 *   ADR-028: asking the same question twice stores one row, and a row for
 *   one provider, model, prompt version or excerpt can never be served as
 *   the answer for another.
 * - **Immutable rows.** There is no update path. A changed context,
 *   prompt, provider or model produces a new row; nothing a reader has
 *   already seen is rewritten.
 * - **`source_id` is `INTEGER`**, matching `dictionary_sources.id`, which
 *   is an `INTEGER PRIMARY KEY`. It records which dictionary artifact
 *   produced the senses that were sent - provenance, deliberately not
 *   identity.
 */
const VERSION_2 = `
CREATE TABLE vocabulary_explanations (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL,
  page           INTEGER NOT NULL,
  context_hash   TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  explanation    TEXT NOT NULL CHECK (length(explanation) <= 2000),
  sense_index    INTEGER,
  truncated      INTEGER NOT NULL DEFAULT 0,
  source_id      INTEGER REFERENCES dictionary_sources(id),
  created_at     TEXT NOT NULL,
  UNIQUE (item_id, document_id, page, context_hash, prompt_version, provider_id, model_id)
);

CREATE INDEX idx_explanations_item_doc_page
  ON vocabulary_explanations (item_id, document_id, page);
`;

/**
 * One step from the version before it to the version it declares.
 *
 * Later milestones append; they never edit an existing step, because a step
 * that has run on a reader's machine is history.
 */
export interface MigrationStep {
  readonly version: number;
  /** Set when the step changes or drops existing data (ADR-021). */
  readonly rewritesData: boolean;
  readonly apply: (database: DatabaseSync) => void;
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    rewritesData: false,
    apply: (database): void => {
      database.exec(VERSION_1);
    },
  },
  {
    version: 2,
    rewritesData: false,
    apply: (database): void => {
      database.exec(VERSION_2);
    },
  },
];

export const readSchemaVersion = (database: DatabaseSync): number => {
  const row = database.prepare('PRAGMA user_version').get() as
    { user_version?: unknown } | undefined;
  const version = row?.['user_version'];

  return typeof version === 'number' ? version : 0;
};

/** Thrown when the file was written by a build newer than this one. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`database schema version ${found} is newer than ${supported}`);
    this.name = 'SchemaTooNewError';
  }
}

/** Thrown when a step failed. The database is unchanged. */
export class MigrationFailedError extends Error {
  constructor(
    readonly version: number,
    override readonly cause: unknown,
  ) {
    super(`migration to version ${version} failed`);
    this.name = 'MigrationFailedError';
  }
}

export interface MigrationOutcome {
  readonly from: number;
  readonly to: number;
  /** True when a step that rewrites data ran, so a backup was warranted. */
  readonly rewroteData: boolean;
}

/** A migration discovered after the current schema version. */
export const pendingMigrations = (database: DatabaseSync): readonly MigrationStep[] => {
  const version = readSchemaVersion(database);

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION);
  }

  return MIGRATIONS.filter((step) => step.version > version);
};

/** Thrown when the synchronous path is asked to run a data-rewriting step. */
export class DestructiveMigrationRequiresBackupError extends Error {
  constructor(readonly version: number) {
    super(`migration to version ${version} requires a verified backup`);
    this.name = 'DestructiveMigrationRequiresBackupError';
  }
}

/**
 * Executes one migration body inside a transaction owned by the caller.
 *
 * This function never begins, commits or rolls back. It updates user_version
 * only after the body succeeds, so the caller's rollback restores both the
 * schema/data and the version marker.
 */
export const applyMigrationBody = (database: DatabaseSync, step: MigrationStep): void => {
  step.apply(database);
  database.exec(`PRAGMA user_version = ${String(step.version)}`);
};

/**
 * Brings a database up to `CURRENT_SCHEMA_VERSION` inside a transaction
 * already acquired by the caller. The caller owns commit/rollback and must
 * invoke this only after any required backup/consistency checks.
 */
export const migrateInOwnedTransaction = (
  database: DatabaseSync,
  steps: readonly MigrationStep[] = pendingMigrations(database),
): MigrationOutcome => {
  const from = readSchemaVersion(database);
  let rewroteData = false;

  for (const step of steps) {
    if (step.version <= from) continue;
    applyMigrationBody(database, step);
    rewroteData ||= step.rewritesData;
  }

  return { from, to: steps.length === 0 ? from : steps[steps.length - 1]!.version, rewroteData };
};

/**
 * Brings a database up to `CURRENT_SCHEMA_VERSION`.
 *
 * `BEGIN IMMEDIATE` takes the write lock before any work, so a second
 * process cannot interleave with a migration; a throwing step is rolled
 * back and the version is left where it was. Measured in the investigation:
 * a failed step on a ten-thousand-item database left no partial table
 * behind, and the successful ten-thousand-item migration took 14.9 ms.
 */
export const migrate = (
  database: DatabaseSync,
  onBackup?: (version: number) => void,
): MigrationOutcome => {
  const from = readSchemaVersion(database);
  const steps = pendingMigrations(database);

  const rewroteData = false;

  for (const step of steps) {
    if (step.rewritesData) {
      // The synchronous path is deliberately fail-closed until the
      // asynchronous verified-backup coordinator is integrated. The
      // callback remains in the signature as the future integration seam,
      // but it cannot make an asynchronous backup safe here.
      void onBackup;
      throw new DestructiveMigrationRequiresBackupError(step.version);
    }

    database.exec('BEGIN IMMEDIATE');

    try {
      applyMigrationBody(database, step);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // A step that failed before opening its transaction has nothing to
        // roll back; the original error is the one worth reporting.
      }

      throw new MigrationFailedError(step.version, error);
    }
  }

  return { from, to: CURRENT_SCHEMA_VERSION, rewroteData };
};
