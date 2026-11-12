import { formatReleaseVersion, parseReleaseVersion } from '@core/update/version';

/**
 * What the update check remembers between launches.
 *
 * Three facts, in a small file of their own in the per-user data
 * directory: whether the reader wants the automatic check, when the last
 * check that got an answer was made, and the newest version that check
 * saw. The file is deliberately separate from the reading state — it is
 * not one of the four settings of ADR-031 and it describes the
 * application, not how a document is shown.
 *
 * Nothing here can fail loudly. A file that is missing, unreadable or
 * malformed reads as the defaults, and a write that fails is reported as a
 * diagnostic: an update check that cannot remember something must never
 * interrupt reading.
 */

export const UPDATE_SETTINGS_FILE = 'update-settings.json';

export interface UpdateSettings {
  /** On unless the reader has turned it off. */
  readonly automatic: boolean;
  /** ISO time of the last check that was answered, or `null`. */
  readonly lastCheckedAt: string | null;
  /** The newest released version that check saw, or `null`. */
  readonly latestSeenVersion: string | null;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  automatic: true,
  lastCheckedAt: null,
  latestSeenVersion: null,
};

export interface UpdateSettingsFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface UpdateSettingsStore {
  read(): Promise<UpdateSettings>;
  write(settings: UpdateSettings): Promise<void>;
}

const parseTime = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))
    ? value
    : null;

export const parseUpdateSettings = (value: unknown): UpdateSettings => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_UPDATE_SETTINGS;
  }

  const source = value as Record<string, unknown>;
  const version = parseReleaseVersion(source['latestSeenVersion']);

  return {
    // Only an explicit `false` turns the check off: a damaged file must
    // not silently leave a reader on an old version.
    automatic: source['automatic'] !== false,
    lastCheckedAt: parseTime(source['lastCheckedAt']),
    latestSeenVersion: version === null ? null : formatReleaseVersion(version),
  };
};

export const createUpdateSettingsStore = ({
  filePath,
  files,
  onDiagnostic = (): void => {},
}: {
  readonly filePath: string;
  readonly files: UpdateSettingsFiles;
  readonly onDiagnostic?: (message: string) => void;
}): UpdateSettingsStore => {
  let cached: UpdateSettings | null = null;

  return {
    read: async (): Promise<UpdateSettings> => {
      if (cached !== null) {
        return cached;
      }

      try {
        cached = parseUpdateSettings(JSON.parse(await files.readFile(filePath)));
      } catch {
        // Missing on a first launch, which is the normal case.
        cached = DEFAULT_UPDATE_SETTINGS;
      }

      return cached;
    },
    write: async (settings: UpdateSettings): Promise<void> => {
      cached = settings;

      try {
        await files.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`);
      } catch (error) {
        onDiagnostic(
          `update settings could not be saved: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    },
  };
};
