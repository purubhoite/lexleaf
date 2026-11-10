import { createHash, randomUUID } from 'node:crypto';
import {
  open as openFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  lstat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqlite from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from './schema';

const backupApi = (
  sqlite as unknown as {
    backup?: (source: DatabaseSync, destination: string, options?: unknown) => Promise<void>;
  }
).backup;

export const BACKUP_DIRECTORY = 'vocabulary-backups';
export const MANIFEST_FILENAME = 'manifest.json';
export const DATABASE_FILENAME = 'vocabulary.db';
export const DEFAULT_RETENTION = 3;

export interface VocabularyBackupManifest {
  readonly formatVersion: 1;
  readonly backupId: string;
  readonly createdAt: string;
  readonly applicationVersion: string;
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  readonly databaseFilename: string;
  readonly databaseSize: number;
  readonly sha256: string;
  readonly backupMethod: 'sqlite.backup';
  readonly validation: {
    readonly quickCheck: 'ok';
    readonly independentlyOpened: true;
    readonly sidecarsRequired: false;
  };
  readonly provenance: {
    readonly source: 'vocabulary-database-runtime';
    readonly journalMode: string;
  };
}

export interface VocabularyBackupCoordinatorOptions {
  readonly userDataPath: string;
  readonly applicationVersion: string;
  readonly sqliteVersion?: string;
  readonly retention?: number;
  /** Test/integration override for a synthetic future schema; production uses current. */
  readonly supportedSchemaVersion?: number;
  readonly now?: () => Date;
  readonly backup?: (source: DatabaseSync, destination: string) => Promise<void>;
}

export type BackupArtifactStatus =
  | 'valid-published'
  | 'incomplete-temporary'
  | 'invalid-manifest'
  | 'hash-mismatch'
  | 'integrity-failure'
  | 'schema-mismatch'
  | 'unsupported-version'
  | 'inaccessible'
  | 'symlink'
  | 'quarantined';

export interface BackupArtifactInspection {
  readonly name: string;
  readonly status: BackupArtifactStatus;
  readonly reason?: string;
  readonly manifest?: VocabularyBackupManifest;
}

export interface QuarantineResult {
  readonly originalName: string;
  readonly quarantineName: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface VocabularyBackupCoordinator {
  create(source: DatabaseSync): Promise<VocabularyBackupManifest>;
  inspect(): Promise<readonly VocabularyBackupManifest[]>;
  verify(backupId: string): Promise<VocabularyBackupManifest | null>;
  inventory(): Promise<readonly BackupArtifactInspection[]>;
  quarantine(name: string, reason: string): Promise<QuarantineResult>;
}

const sha256 = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

const flushFile = async (path: string): Promise<void> => {
  const handle = await openFile(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const flushDirectory = async (path: string): Promise<void> => {
  try {
    const handle = await openFile(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    // Some platforms do not permit opening directories for fsync. Only those
    // documented unsupported-operation errors are non-fatal; permission,
    // I/O and descriptor failures must abort publication.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EINVAL' && code !== 'EISDIR') {
      throw error;
    }
  }
};

const validHex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export const parseVocabularyBackupManifest = (value: unknown): VocabularyBackupManifest => {
  if (typeof value !== 'object' || value === null) throw new Error('invalid backup manifest');
  const v = value as Record<string, unknown>;
  const validation = v['validation'];
  const provenance = v['provenance'];
  if (
    v['formatVersion'] !== 1 ||
    typeof v['backupId'] !== 'string' ||
    v['backupId'].length === 0 ||
    typeof v['createdAt'] !== 'string' ||
    typeof v['applicationVersion'] !== 'string' ||
    typeof v['schemaVersion'] !== 'number' ||
    !Number.isInteger(v['schemaVersion']) ||
    typeof v['sqliteVersion'] !== 'string' ||
    v['databaseFilename'] !== DATABASE_FILENAME ||
    typeof v['databaseSize'] !== 'number' ||
    !Number.isInteger(v['databaseSize']) ||
    v['databaseSize'] < 0 ||
    !validHex(v['sha256']) ||
    v['backupMethod'] !== 'sqlite.backup' ||
    typeof validation !== 'object' ||
    validation === null ||
    (validation as Record<string, unknown>)['quickCheck'] !== 'ok' ||
    (validation as Record<string, unknown>)['independentlyOpened'] !== true ||
    (validation as Record<string, unknown>)['sidecarsRequired'] !== false ||
    typeof provenance !== 'object' ||
    provenance === null ||
    (provenance as Record<string, unknown>)['source'] !== 'vocabulary-database-runtime' ||
    typeof (provenance as Record<string, unknown>)['journalMode'] !== 'string'
  )
    throw new Error('invalid backup manifest');
  return value as VocabularyBackupManifest;
};

export const createVocabularyBackupCoordinator = ({
  userDataPath,
  applicationVersion,
  sqliteVersion = process.versions.sqlite ?? 'unknown',
  retention = DEFAULT_RETENTION,
  supportedSchemaVersion = CURRENT_SCHEMA_VERSION,
  now = (): Date => new Date(),
  backup = backupApi,
}: VocabularyBackupCoordinatorOptions): VocabularyBackupCoordinator => {
  if (backup === undefined) throw new Error('node:sqlite backup API is unavailable');
  if (!Number.isInteger(retention) || retention < 1)
    throw new Error('backup retention must be at least one');
  const root = join(userDataPath, BACKUP_DIRECTORY);

  const verifyDirectory = async (directory: string): Promise<VocabularyBackupManifest | null> => {
    try {
      const manifest = parseVocabularyBackupManifest(
        JSON.parse(await readFile(join(directory, MANIFEST_FILENAME), 'utf8')),
      );
      const databasePath = join(directory, DATABASE_FILENAME);
      const info = await stat(databasePath);
      if (info.size !== manifest.databaseSize || (await sha256(databasePath)) !== manifest.sha256)
        return null;
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const quick = (
          database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
        )?.quick_check;
        if (
          quick !== 'ok' ||
          readSchemaVersion(database) !== manifest.schemaVersion ||
          manifest.schemaVersion > supportedSchemaVersion
        )
          return null;
        const journal = (
          database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined
        )?.journal_mode;
        if (typeof journal !== 'string') return null;
      } finally {
        database.close();
      }
      return manifest;
    } catch {
      return null;
    }
  };

  const inspectArtifact = async (name: string): Promise<BackupArtifactInspection> => {
    const artifact = join(root, name);
    try {
      const entry = await lstat(artifact);
      if (entry.isSymbolicLink())
        return { name, status: 'symlink', reason: 'symbolic link is not trusted' };
      if (name.startsWith('.tmp-'))
        return { name, status: 'incomplete-temporary', reason: 'temporary publication artifact' };
      if (name.startsWith('.quarantine-')) return { name, status: 'quarantined' };
      if (!entry.isDirectory())
        return { name, status: 'inaccessible', reason: 'published artifact is not a directory' };
      const manifestPath = join(artifact, MANIFEST_FILENAME);
      const databasePath = join(artifact, DATABASE_FILENAME);
      let manifest: VocabularyBackupManifest;
      try {
        manifest = parseVocabularyBackupManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
      } catch {
        return { name, status: 'invalid-manifest', reason: 'manifest is malformed' };
      }
      if (manifest.backupId !== name)
        return { name, status: 'invalid-manifest', reason: 'manifest identity mismatch' };
      const dbEntry = await lstat(databasePath).catch(() => null);
      if (dbEntry === null || dbEntry.isSymbolicLink() || !dbEntry.isFile())
        return {
          name,
          status: 'inaccessible',
          reason: 'database artifact is inaccessible or linked',
        };
      const info = await stat(databasePath);
      if (info.size !== manifest.databaseSize || (await sha256(databasePath)) !== manifest.sha256)
        return { name, status: 'hash-mismatch', manifest };
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const quick = (
          database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
        )?.quick_check;
        const version = readSchemaVersion(database);
        if (quick !== 'ok') return { name, status: 'integrity-failure', manifest };
        if (version !== manifest.schemaVersion)
          return { name, status: 'schema-mismatch', manifest };
        if (version > supportedSchemaVersion)
          return { name, status: 'unsupported-version', manifest };
      } finally {
        database.close();
      }
      return { name, status: 'valid-published', manifest };
    } catch {
      return { name, status: 'inaccessible', reason: 'artifact cannot be inspected' };
    }
  };

  const inventory = async (): Promise<readonly BackupArtifactInspection[]> => {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const results: BackupArtifactInspection[] = [];
    for (const name of entries) results.push(await inspectArtifact(name));
    return results;
  };

  const quarantine = async (name: string, reason: string): Promise<QuarantineResult> => {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..')
      throw new Error('invalid backup artifact name');
    const source = join(root, name);
    const sourceEntry = await lstat(source);
    if (sourceEntry.isSymbolicLink() && !source.startsWith(`${root}/`))
      throw new Error('unsafe backup artifact path');
    const timestamp = new Date().toISOString();
    const quarantineName = `.quarantine-${timestamp.replace(/[^0-9]/g, '')}-${randomUUID()}`;
    const destination = join(root, quarantineName);
    await mkdir(destination);
    try {
      await writeFile(
        join(destination, 'quarantine.json'),
        JSON.stringify({ originalName: name, reason, timestamp }, null, 2),
        { flag: 'wx' },
      );
      await rename(source, join(destination, 'artifact'));
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      // The source remains in place if quarantine publication fails.
      throw error;
    }
    await flushDirectory(root);
    return { originalName: name, quarantineName, reason, timestamp };
  };

  const inspect = async (): Promise<readonly VocabularyBackupManifest[]> => {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const found: VocabularyBackupManifest[] = [];
    for (const entry of entries) {
      const manifest = await verifyDirectory(join(root, entry));
      if (manifest !== null) found.push(manifest);
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };

  return {
    async create(source): Promise<VocabularyBackupManifest> {
      await mkdir(root, { recursive: true });
      const backupId = `${now()
        .toISOString()
        .replace(/[^0-9]/g, '')}-${randomUUID()}`;
      const temporary = join(root, `.tmp-${backupId}`);
      const published = join(root, backupId);
      await mkdir(temporary);
      try {
        const temporaryDatabase = join(temporary, DATABASE_FILENAME);
        await backup(source, temporaryDatabase);
        const independent = new DatabaseSync(temporaryDatabase);
        let journalMode = 'unknown';
        let backupSchemaVersion = 0;
        try {
          const quick = (
            independent.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
          )?.quick_check;
          const version = readSchemaVersion(independent);
          backupSchemaVersion = version;
          journalMode = String(
            (
              independent.prepare('PRAGMA journal_mode').get() as
                { journal_mode?: unknown } | undefined
            )?.journal_mode ?? 'unknown',
          );
          if (quick !== 'ok' || version > supportedSchemaVersion)
            throw new Error('backup validation failed');
        } finally {
          independent.close();
        }
        const info = await stat(temporaryDatabase);
        const manifest: VocabularyBackupManifest = {
          formatVersion: 1,
          backupId,
          createdAt: now().toISOString(),
          applicationVersion,
          schemaVersion: backupSchemaVersion,
          sqliteVersion,
          databaseFilename: DATABASE_FILENAME,
          databaseSize: info.size,
          sha256: await sha256(temporaryDatabase),
          backupMethod: 'sqlite.backup',
          validation: { quickCheck: 'ok', independentlyOpened: true, sidecarsRequired: false },
          provenance: { source: 'vocabulary-database-runtime', journalMode },
        };
        await writeFile(
          join(temporary, MANIFEST_FILENAME),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { flag: 'wx' },
        );
        await flushFile(temporaryDatabase);
        await flushFile(join(temporary, MANIFEST_FILENAME));
        await flushDirectory(temporary);
        await rename(temporary, published);
        await flushDirectory(root);
        const publishedManifest = await verifyDirectory(published);
        if (publishedManifest === null)
          throw new Error('published backup failed independent verification');
        const existing = (await inspect()).filter((item) => item.backupId !== backupId);
        for (const old of existing.slice(retention))
          await rm(join(root, old.backupId), { recursive: true, force: true });
        return publishedManifest;
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    },
    inspect,
    inventory,
    quarantine,
    async verify(backupId) {
      if (!/^[A-Za-z0-9._-]+$/.test(backupId)) return null;
      return verifyDirectory(join(root, backupId));
    },
  };
};
