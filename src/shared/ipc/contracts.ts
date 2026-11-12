/**
 * Data contracts crossing the process boundary.
 *
 * Everything here must be structured-clone serialisable and free of Node.js or
 * Electron types, because these shapes are consumed by renderer code that runs
 * without Node.js integration.
 */

import type {
  DictionaryAbsentField,
  DictionaryAttribution,
  DictionaryPartOfSpeech,
  DictionaryPronunciation,
  DictionaryQuery,
  DictionaryResolution,
  DictionaryResult,
  DictionarySense,
  DictionaryUnavailableReason,
} from '@core/dictionary/types';
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  type Preferences,
} from '@core/persistence/preferences';
import type { ReadingPosition, ZoomMode, ZoomState } from '@core/persistence/types';
import type { UpdateBridge } from './updateContracts';
import type { VocabularyExportFormat, VocabularyExportOutcome } from '@core/vocabulary/export';
import type { SavedOccurrence, SavedWord, SavedWordState } from '@core/vocabulary/types';
import type {
  AiIpcResult,
  AiStatusReply,
  ExplainIpcRequest,
  ExplanationIpcView,
  StoredExplanationIpcQuery,
} from './aiContracts';
import type {
  LibraryIpcPage,
  LibraryIpcQuery,
  SaveWordIpcRequest,
  SearchIpcQuery,
  SearchIpcResults,
  StateForWordRequest,
  VocabularyIpcResult,
  VocabularyRecoveryListResult,
  VocabularyRecoveryRestoreResult,
} from './vocabularyContracts';

/** Key under which the preload script exposes the desktop bridge on `window`. */
export const DESKTOP_BRIDGE_KEY = 'lexleaf';

/** Static, non-sensitive description of the running application. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
}

/**
 * A document the user chose, delivered as bytes.
 *
 * The renderer receives the contents, a display name and a content-derived
 * id, never a filesystem path: it has no business reaching the filesystem,
 * and the main process stays the only component that resolves paths.
 */
export interface DocumentPayload {
  /** Content-derived identity, stable across moves and renames (ADR-016). */
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
  /** Where this document was last left, or `null` if it is new or unknown. */
  readonly position: ReadingPosition | null;
  /**
   * The zoom the reader was reading at *before* this document was opened,
   * or `null` if there was no earlier document to take one from.
   *
   * This is what `defaultZoomMode: 'last-used'` resolves to, and it travels
   * with the open rather than sitting in the reader-state snapshot because
   * the main process records an open before the renderer resolves a zoom:
   * a snapshot read after that point describes the document being opened,
   * not the one before it (6.8 closure audit). Optional so that a payload
   * built without one degrades to the plain default zoom rather than to a
   * wrong one.
   */
  readonly lastUsedZoom?: ZoomState | null;
}

/**
 * Why a document could not be opened, as a closed set of codes (M7.2).
 *
 * Until M7.2 this field was a sentence built in the main process, and the
 * sentence for an unexpected failure was the exception's own message — so
 * `ENOENT: no such file or directory, stat '/home/…/Medical Report.pdf'`
 * was rendered into the reader's window (M7 investigation R2). The type is
 * the fix: a value of this union cannot hold a path, an `errno`, a driver
 * string or anything else the filesystem said, because there is no member
 * of it that is free text. What the operating system reported goes to the
 * main-process diagnostic log and stops there.
 *
 * The renderer turns one of these into one sentence
 * (`renderer/src/reader/documentFailure.ts`), which is the same shape the
 * dictionary, the vocabulary store and the AI provider already use.
 */
export const DOCUMENT_FAILURE_REASONS = [
  /** The file is not there: deleted, renamed, moved, or never existed. */
  'missing',
  /** It exists but this user may not read it, or the read itself failed. */
  'unreadable',
  /** The path names a directory, a device or something else that is not a file. */
  'not-a-file',
  /** Larger than {@link MAX_DOCUMENT_BYTES}, so it is refused rather than loaded. */
  'too-large',
  /** Anything else. Deliberately last, and deliberately uninformative. */
  'unknown',
] as const;

export type DocumentFailureReason = (typeof DOCUMENT_FAILURE_REASONS)[number];

const isDocumentFailureReason = (value: unknown): value is DocumentFailureReason =>
  typeof value === 'string' && (DOCUMENT_FAILURE_REASONS as readonly string[]).includes(value);

/**
 * A document that could not be opened.
 *
 * `name` is the file's own name and never its location: it is produced by
 * `basename` and scrubbed of separators in the main process, so the reader
 * can be told *which* document failed — which is what the recent list has
 * always done — without being told where it lives. `null` where there is
 * no name to give, such as an id the renderer made up.
 */
export interface DocumentFailure {
  readonly status: 'unreadable';
  readonly reason: DocumentFailureReason;
  readonly name: string | null;
}

/** Result of asking the main process for a document. */
export type DocumentRequestResult =
  | { readonly status: 'opened'; readonly document: DocumentPayload }
  | { readonly status: 'none' }
  | DocumentFailure;

/**
 * A previously read document, as the renderer is allowed to see it.
 *
 * No path: a recent document is reopened by id, and the main process resolves
 * the id to a file itself.
 */
export interface RecentDocument {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly pageCount: number | null;
  readonly lastPage: number;
  /** ISO 8601. */
  readonly lastOpenedAt: string;
  /** False once the file behind the entry has been found to be gone. */
  readonly available: boolean;
}

/**
 * Whether this renderer is the first of the session or a replacement for
 * one that died (M7.1, ADR-035).
 *
 * A closed value for the same reason {@link DocumentFailureReason} is: the
 * renderer is told *what happened*, never why. The exit reason, the exit
 * code and anything Chromium said about it stay in the main-process log.
 * It rides on the state snapshot the shell already reads at startup rather
 * than on a channel of its own — a reloaded renderer asks for its state
 * exactly once, and this is part of that state.
 */
export const SESSION_RECOVERY_STATES = [
  /** An ordinary start, or an ordinary reload the reader asked for. */
  'none',
  /** This renderer replaces one that stopped unexpectedly. */
  'after-crash',
] as const;

export type SessionRecovery = (typeof SESSION_RECOVERY_STATES)[number];

const isSessionRecovery = (value: unknown): value is SessionRecovery =>
  typeof value === 'string' && (SESSION_RECOVERY_STATES as readonly string[]).includes(value);

export interface ReaderStateSnapshot {
  /** Most recently used first. */
  readonly recents: readonly RecentDocument[];
  readonly lastDocumentId: string | null;
  /** The four settings, resolved (ADR-031). Always complete, always valid. */
  readonly preferences: Preferences;
  /** How this renderer came to exist (M7.1). */
  readonly sessionRecovery: SessionRecovery;
}

/**
 * What an application that has read nothing yet reports.
 *
 * Exported because the renderer needs a starting value before the first
 * reply arrives, and because "empty" has to mean the same thing in both
 * places — a snapshot assembled by hand is a snapshot that forgets a field
 * the next time one is added.
 */
export const EMPTY_READER_STATE_SNAPSHOT: ReaderStateSnapshot = {
  recents: [],
  lastDocumentId: null,
  preferences: DEFAULT_PREFERENCES,
  sessionRecovery: 'none',
};

/**
 * Whether the last attempt to write reading state reached the disk (M7.2).
 *
 * Every channel that causes a write answers with one of these two words.
 * The rule it enforces is small and specific: a failed write must not be
 * reported as a successful one. It stays a *closed* value for the same
 * reason the document failure reason is — whatever the filesystem said
 * about the failure belongs in the main-process log, not in a reply the
 * renderer could render.
 *
 * `failing` describes the most recent write attempt, not the session: a
 * store that writes successfully again reports `ok` again. Deciding what
 * to do about it is the renderer's business, and what it does is show one
 * dismissible notice (ADR-034) — never interrupt reading, and never a
 * second notice for the same trouble.
 */
export type StateWriteHealth = 'ok' | 'failing';

/**
 * Reads a write-health reply.
 *
 * Anything that is not the word `failing` is `ok`: a reply that did not
 * arrive in the expected shape is not evidence that the disk is broken,
 * and crying wolf at the reader is its own defect.
 */
export const parseStateWriteHealth = (value: unknown): StateWriteHealth =>
  value === 'failing' ? 'failing' : 'ok';

/** A reading position the renderer wants remembered. */
export interface ReadingPositionUpdate {
  readonly documentId: string;
  readonly position: ReadingPosition;
  /** Reported once the document has been parsed, so recents can show it. */
  readonly pageCount: number | null;
}

/**
 * The complete API surface the renderer is allowed to reach.
 *
 * Every future capability (dictionary, licensing, ...) must be added here as
 * an explicit, narrowly scoped operation.
 */
/**
 * The vocabulary half of the bridge.
 *
 * Grouped under one name because it is one subsystem, and kept to seven
 * operations that each answer a question the library screen or the word
 * popup actually asks. Every one of them returns a typed result rather
 * than throwing: a vocabulary that cannot be reached must not interrupt
 * reading.
 */
export interface VocabularyBridge {
  readonly stateForWord: (
    request: StateForWordRequest,
  ) => Promise<VocabularyIpcResult<SavedWordState>>;
  readonly save: (request: SaveWordIpcRequest) => Promise<VocabularyIpcResult<SavedWord>>;
  readonly remove: (itemId: string) => Promise<VocabularyIpcResult<null>>;
  readonly restore: (itemId: string) => Promise<VocabularyIpcResult<null>>;
  readonly list: (query: LibraryIpcQuery) => Promise<VocabularyIpcResult<LibraryIpcPage>>;
  readonly search: (query: SearchIpcQuery) => Promise<VocabularyIpcResult<SearchIpcResults>>;
  readonly occurrences: (
    itemId: string,
  ) => Promise<VocabularyIpcResult<readonly SavedOccurrence[]>>;
  /**
   * Writes every saved word to a file. The reader picks the file in the
   * system's save window; the page chooses only the format and learns only
   * how many words were written.
   */
  readonly exportLibrary: (format: VocabularyExportFormat) => Promise<VocabularyExportOutcome>;
}

/**
 * The contextual-explanation half of the bridge.
 *
 * Four operations, and nothing in any of them that could name a
 * destination: the renderer asks whether a provider exists, reads what is
 * already known, asks for one explanation of one passage, and abandons it.
 * The endpoint, the model, the credential and the prompt live in the main
 * process and never appear here.
 */
export interface AiBridge {
  /** Labels only, so the popup can disclose where text would go. */
  readonly status: () => Promise<AiStatusReply>;
  /** Reads an existing explanation. Never causes a network call. */
  readonly storedExplanation: (
    query: StoredExplanationIpcQuery,
  ) => Promise<ExplanationIpcView | null>;
  readonly explain: (request: ExplainIpcRequest) => Promise<AiIpcResult<ExplanationIpcView>>;
  readonly cancel: (requestId: string) => Promise<void>;
}

export interface RecoveryBridge {
  readonly listBackups: () => Promise<VocabularyRecoveryListResult>;
  readonly restore: (
    backupId: string,
    confirmedBackupId: string,
  ) => Promise<VocabularyRecoveryRestoreResult>;
}

export interface DesktopBridge {
  readonly getAppInfo: () => Promise<AppInfo>;
  /** Shows the system file chooser and returns the chosen document. */
  readonly openDocumentDialog: () => Promise<DocumentRequestResult>;
  /** Returns the document named on the command line, if any. */
  readonly getInitialDocument: () => Promise<DocumentRequestResult>;
  /** Recent documents and which one was open last. */
  readonly getReaderState: () => Promise<ReaderStateSnapshot>;
  /** Reopens a document the application has seen before, by id. */
  readonly openRecentDocument: (documentId: string) => Promise<DocumentRequestResult>;
  /**
   * Remembers where the reader is.
   *
   * A failure never throws and never interrupts reading, but it is no
   * longer silent either: the reply says whether the last write reached
   * the disk (M7.2, ADR-034).
   */
  readonly saveReadingPosition: (update: ReadingPositionUpdate) => Promise<StateWriteHealth>;
  /** Removes a document from the recent list. */
  readonly forgetDocument: (documentId: string) => Promise<StateWriteHealth>;
  /**
   * Stores the four settings (ADR-031).
   *
   * One typed object of enumerated values, and the only way the renderer
   * can change anything durable about how the application looks. A
   * failure must not interrupt reading, for the same reason a position
   * save must not — and, since M7.2, must not be invisible either: the
   * reply carries the health of the write (ADR-034).
   */
  readonly savePreferences: (preferences: Preferences) => Promise<StateWriteHealth>;
  /**
   * Looks one word up in the bundled offline dictionary.
   *
   * The renderer names a word and nothing else: it cannot choose a file, a
   * dictionary, a provider or a location.
   */
  readonly lookUpWord: (query: DictionaryQuery) => Promise<DictionaryResult>;
  /** The vocabulary the reader has built: saving, listing and returning to it. */
  readonly vocabulary: VocabularyBridge;
  /** Contextual explanation of one word in one short passage. */
  readonly ai: AiBridge;
  readonly recovery?: RecoveryBridge;
  /** Checking for a newer release. Absent in builds and tests without it. */
  readonly updates?: UpdateBridge;
  /**
   * Opens a prefilled problem report in the reader's browser. It takes
   * nothing and sends nothing; `false` means the page could not be opened.
   * Absent in a build that has nowhere to report to.
   */
  readonly reportProblem?: () => Promise<boolean>;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Validates data received over IPC before it is handed to application code.
 *
 * IPC payloads are untrusted input at the boundary, so they are parsed rather
 * than type-asserted.
 */
export const parseAppInfo = (value: unknown): AppInfo | null => {
  if (!isObject(value)) {
    return null;
  }

  const candidate = value as Partial<Record<keyof AppInfo, unknown>>;

  if (
    !isNonEmptyString(candidate.name) ||
    !isNonEmptyString(candidate.version) ||
    !isNonEmptyString(candidate.electronVersion) ||
    !isNonEmptyString(candidate.chromeVersion)
  ) {
    return null;
  }

  return {
    name: candidate.name,
    version: candidate.version,
    electronVersion: candidate.electronVersion,
    chromeVersion: candidate.chromeVersion,
  };
};

const ZOOM_MODES: readonly ZoomMode[] = ['fixed', 'fit-width', 'fit-page'];

const parseZoomState = (value: unknown): ZoomState | null => {
  if (!isObject(value)) {
    return null;
  }

  const mode = ZOOM_MODES.find((candidate) => candidate === value['mode']);
  const scale = value['scale'];

  if (mode === undefined || !isFiniteNumber(scale) || scale <= 0) {
    return null;
  }

  return { mode, scale };
};

/** Parses a reading position; returns `null` rather than a repaired guess. */
export const parseReadingPosition = (value: unknown): ReadingPosition | null => {
  if (!isObject(value)) {
    return null;
  }

  const page = value['page'];
  const fraction = value['pageOffsetFraction'];
  const zoom = parseZoomState(value['zoom']);

  if (!isFiniteNumber(page) || page < 1 || !isFiniteNumber(fraction) || zoom === null) {
    return null;
  }

  return {
    page: Math.floor(page),
    pageOffsetFraction: Math.min(Math.max(fraction, 0), 1),
    zoom,
  };
};

/**
 * Validates a document request result received over IPC.
 *
 * The payload carries binary data, so the shape is checked explicitly rather
 * than trusted.
 */
export const parseDocumentRequestResult = (value: unknown): DocumentRequestResult | null => {
  if (!isObject(value)) {
    return null;
  }

  const candidate = value as {
    status?: unknown;
    reason?: unknown;
    name?: unknown;
    document?: unknown;
  };

  if (candidate.status === 'none') {
    return { status: 'none' };
  }

  if (candidate.status === 'unreadable') {
    /*
     * The reason is narrowed to the closed set here, at the boundary, and
     * a value outside it becomes `unknown` rather than travelling on or
     * becoming a malformed reply. Both halves matter: a reason this build
     * of the renderer does not know is still a failure the reader has to
     * be told about, and nothing that is not one of the five words can
     * reach the sentence the reader is shown (M7.2).
     */
    return {
      status: 'unreadable',
      reason: isDocumentFailureReason(candidate.reason) ? candidate.reason : 'unknown',
      name: isNonEmptyString(candidate.name) ? candidate.name : null,
    };
  }

  if (candidate.status !== 'opened' || !isObject(candidate.document)) {
    return null;
  }

  const document = candidate.document;

  if (
    !isNonEmptyString(document['id']) ||
    !isNonEmptyString(document['name']) ||
    !isFiniteNumber(document['sizeBytes']) ||
    !(document['bytes'] instanceof Uint8Array)
  ) {
    return null;
  }

  return {
    status: 'opened',
    document: {
      id: document['id'],
      name: document['name'],
      sizeBytes: document['sizeBytes'],
      bytes: document['bytes'],
      // A malformed stored position must not stop a document opening; it is
      // simply forgotten and the reader starts at the beginning.
      position: parseReadingPosition(document['position']),
      // Same rule for the last-used zoom hint: unusable means absent, which
      // means the default zoom, not a failed open.
      lastUsedZoom: parseZoomState(document['lastUsedZoom']),
    },
  };
};

const parseRecentDocument = (value: unknown): RecentDocument | null => {
  if (!isObject(value)) {
    return null;
  }

  const pageCount = value['pageCount'];
  const lastPage = value['lastPage'];

  if (
    !isNonEmptyString(value['id']) ||
    !isNonEmptyString(value['name']) ||
    !isNonEmptyString(value['lastOpenedAt']) ||
    !isFiniteNumber(value['sizeBytes']) ||
    !isFiniteNumber(lastPage) ||
    typeof value['available'] !== 'boolean'
  ) {
    return null;
  }

  return {
    id: value['id'],
    name: value['name'],
    sizeBytes: value['sizeBytes'],
    pageCount: isFiniteNumber(pageCount) ? pageCount : null,
    lastPage: Math.max(1, Math.floor(lastPage)),
    lastOpenedAt: value['lastOpenedAt'],
    available: value['available'],
  };
};

export const parseReaderStateSnapshot = (value: unknown): ReaderStateSnapshot | null => {
  if (!isObject(value) || !Array.isArray(value['recents'])) {
    return null;
  }

  const recents = value['recents']
    .map(parseRecentDocument)
    .filter((recent): recent is RecentDocument => recent !== null);

  const lastDocumentId = value['lastDocumentId'];

  return {
    recents,
    lastDocumentId: isNonEmptyString(lastDocumentId) ? lastDocumentId : null,
    // Re-validated on arrival exactly as `recents` is: the renderer trusts
    // the shape of nothing it is handed, and a preference that did not
    // survive the crossing becomes its default rather than an exception.
    preferences: parsePreferences(value['preferences']),
    /*
     * Anything that is not one of the two words means "an ordinary
     * start" (M7.1). Crying crash at a reader because a reply arrived in
     * an unexpected shape would be its own defect, and the same rule the
     * write health follows.
     */
    sessionRecovery: isSessionRecovery(value['sessionRecovery'])
      ? value['sessionRecovery']
      : 'none',
  };
};

/**
 * Validates a preferences payload arriving *from* the renderer.
 *
 * `null` means "this is not a preferences message at all" — anything that
 * is not a plain object, an array included — and the handler reports it
 * and writes nothing. A
 * message that *is* an object is normalised per field instead: an unknown
 * value, a missing field or a key the application does not know about
 * resolves to the default or is dropped, which is ADR-031's rule and the
 * same rule the stored document follows.
 */
export const parsePreferencesUpdate = (value: unknown): Preferences | null =>
  isObject(value) && !Array.isArray(value) ? parsePreferences(value) : null;

/**
 * Validates a position update arriving *from* the renderer.
 *
 * The renderer is untrusted input to the main process just as much as the
 * other way round, so this runs before anything is written to disk.
 */
export const parseReadingPositionUpdate = (value: unknown): ReadingPositionUpdate | null => {
  if (!isObject(value)) {
    return null;
  }

  const documentId = value['documentId'];
  const position = parseReadingPosition(value['position']);
  const pageCount = value['pageCount'];

  if (!isNonEmptyString(documentId) || position === null) {
    return null;
  }

  return {
    documentId,
    position,
    pageCount: isFiniteNumber(pageCount) && pageCount >= 1 ? Math.floor(pageCount) : null,
  };
};

/** Validates a document id arriving from the renderer. */
export const parseDocumentId = (value: unknown): string | null =>
  isNonEmptyString(value) ? value : null;

/* ------------------------------------------------------------------ *
 * Dictionary (Milestone 3)
 * ------------------------------------------------------------------ */

/**
 * The longest word the renderer may ask about.
 *
 * A dictionary query is one word. The bound exists because the renderer is
 * untrusted input to the main process, not because any real word is near it.
 */
export const MAXIMUM_QUERY_LENGTH = 128;

const PARTS_OF_SPEECH: readonly DictionaryPartOfSpeech[] = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'determiner',
  'pronoun',
  'preposition',
  'conjunction',
  'auxiliary verb',
  'particle',
];

const RESOLUTIONS: readonly DictionaryResolution[] = [
  'exact',
  'case',
  'typographic',
  'morphology',
  'closed-class',
];

const UNAVAILABLE_REASONS: readonly DictionaryUnavailableReason[] = [
  'not-installed',
  'unreadable',
  'corrupt',
];

/**
 * Validates a query arriving from the renderer.
 *
 * The renderer may name a *word*. It may not name a file, a provider, a
 * dictionary or a location: there is nothing in this shape that could carry
 * one.
 */
export const parseDictionaryQuery = (value: unknown): DictionaryQuery | null => {
  if (!isObject(value)) {
    return null;
  }

  const normalized = value['normalized'];
  const raw = value['raw'];
  const joined = value['joinedAcrossLines'];

  if (
    typeof normalized !== 'string' ||
    typeof raw !== 'string' ||
    typeof joined !== 'boolean' ||
    normalized.length === 0 ||
    normalized.length > MAXIMUM_QUERY_LENGTH ||
    raw.length > MAXIMUM_QUERY_LENGTH
  ) {
    return null;
  }

  return { normalized, raw, joinedAcrossLines: joined };
};

const parseStringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const parseSense = (value: unknown): DictionarySense | null => {
  if (!isObject(value)) {
    return null;
  }

  const partOfSpeech = PARTS_OF_SPEECH.find((part) => part === value['partOfSpeech']);
  const definition = value['definition'];
  const source = value['source'];

  if (
    partOfSpeech === undefined ||
    !isNonEmptyString(definition) ||
    (source !== 'wordnet' && source !== 'application')
  ) {
    return null;
  }

  return {
    partOfSpeech,
    definition,
    examples: parseStringList(value['examples']),
    synonyms: parseStringList(value['synonyms']),
    source,
  };
};

const parsePronunciations = (value: unknown): readonly DictionaryPronunciation[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const pronunciations: DictionaryPronunciation[] = [];

  for (const candidate of value) {
    if (!isObject(candidate) || !isNonEmptyString(candidate['value'])) {
      continue;
    }

    const variety = candidate['variety'];

    pronunciations.push({
      value: candidate['value'],
      variety: variety === 'US' || variety === 'GB' ? variety : 'unspecified',
    });
  }

  return pronunciations;
};

const parseAttribution = (value: unknown): DictionaryAttribution | null => {
  if (!isObject(value) || !Array.isArray(value['licences'])) {
    return null;
  }

  const licences: { name: string; url: string }[] = [];

  for (const candidate of value['licences']) {
    if (
      !isObject(candidate) ||
      !isNonEmptyString(candidate['name']) ||
      !isNonEmptyString(candidate['url'])
    ) {
      return null;
    }

    licences.push({ name: candidate['name'], url: candidate['url'] });
  }

  const datasetName = value['datasetName'];
  const release = value['release'];
  const statement = value['modificationStatement'];

  if (
    !isNonEmptyString(datasetName) ||
    !isNonEmptyString(release) ||
    !isNonEmptyString(statement)
  ) {
    return null;
  }

  return {
    datasetName,
    release,
    licences,
    modified: value['modified'] === true,
    modificationStatement: statement,
    credits: parseStringList(value['credits']),
  };
};

/**
 * Validates a result arriving from the main process.
 *
 * Parsed rather than trusted for the same reason as every other reply: a
 * malformed message must fail at the boundary instead of inside a component
 * that is trying to render a definition.
 */
export const parseDictionaryResult = (value: unknown): DictionaryResult | null => {
  if (!isObject(value)) {
    return null;
  }

  const status = value['status'];

  if (status === 'unavailable') {
    const reason = UNAVAILABLE_REASONS.find((candidate) => candidate === value['reason']);

    return reason === undefined ? null : { status: 'unavailable', reason };
  }

  if (status === 'not-found') {
    return isNonEmptyString(value['queried'])
      ? {
          status: 'not-found',
          queried: value['queried'],
          attempted: parseStringList(value['attempted']),
        }
      : null;
  }

  if (status !== 'found' && status !== 'partial') {
    return null;
  }

  const resolvedBy = RESOLUTIONS.find((candidate) => candidate === value['resolvedBy']);
  const attribution = parseAttribution(value['attribution']);
  const queried = value['queried'];
  const headword = value['headword'];

  if (
    resolvedBy === undefined ||
    attribution === null ||
    !isNonEmptyString(queried) ||
    !isNonEmptyString(headword) ||
    !Array.isArray(value['senses'])
  ) {
    return null;
  }

  const senses: DictionarySense[] = [];

  for (const candidate of value['senses']) {
    const sense = parseSense(candidate);

    if (sense === null) {
      return null;
    }

    senses.push(sense);
  }

  if (senses.length === 0) {
    return null;
  }

  const answer = {
    queried,
    headword,
    resolvedBy,
    senses,
    pronunciations: parsePronunciations(value['pronunciations']),
    alsoInflectionOf: parseStringList(value['alsoInflectionOf']),
    attribution,
  };

  if (status === 'found') {
    return { status: 'found', ...answer };
  }

  const absent = parseStringList(value['absentFields']).filter(
    (field): field is DictionaryAbsentField =>
      field === 'pronunciation' || field === 'examples' || field === 'synonyms',
  );

  return { status: 'partial', ...answer, absentFields: absent };
};
