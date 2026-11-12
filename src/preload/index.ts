import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { IpcChannel } from '@shared/ipc/channels';
import type { DictionaryQuery, DictionaryResult } from '@core/dictionary/types';
import {
  AI_UNCONFIGURED,
  parseAiStatus,
  parseExplanationResult,
  parseExplanationView,
  type AiStatusReply,
  type ExplainIpcRequest,
  type StoredExplanationIpcQuery,
} from '@shared/ipc/aiContracts';
import { parseVocabularyExportOutcome, type VocabularyExportFormat } from '@core/vocabulary/export';
import type { Preferences } from '@core/persistence/preferences';
import {
  DESKTOP_BRIDGE_KEY,
  parseAppInfo,
  parseDictionaryResult,
  parseDocumentRequestResult,
  parseReaderStateSnapshot,
  parseStateWriteHealth,
  type AiBridge,
  type AppInfo,
  type DesktopBridge,
  type DocumentRequestResult,
  type ReaderStateSnapshot,
  type ReadingPositionUpdate,
  type StateWriteHealth,
  type VocabularyBridge,
} from '@shared/ipc/contracts';
import {
  UPDATE_STATE_UNKNOWN,
  parseUpdateState,
  type UpdateBridge,
  type UpdateIpcState,
} from '@shared/ipc/updateContracts';
import {
  parseLibraryPageResult,
  parseOccurrencesResult,
  parseSavedWordResult,
  parseSearchResults,
  parseStateResult,
  parseVoidResult,
  type LibraryIpcQuery,
  type SaveWordIpcRequest,
  type SearchIpcQuery,
  type StateForWordRequest,
  type VocabularyIpcResult,
  parseVocabularyRecoveryListResult,
  parseVocabularyRecoveryRestoreResult,
} from '@shared/ipc/vocabularyContracts';

/**
 * The preload script is the only place where renderer code meets Electron.
 *
 * It exposes a fixed set of named operations through the context bridge: the
 * renderer never receives `ipcRenderer`, `require`, or any generic "invoke any
 * channel" helper. Every reply is parsed before it is handed on, so a
 * malformed message from the other side fails here rather than deep inside a
 * React component.
 */
const getAppInfo = async (): Promise<AppInfo> => {
  const payload: unknown = await ipcRenderer.invoke(IpcChannel.GetAppInfo);
  const appInfo = parseAppInfo(payload);

  if (appInfo === null) {
    throw new Error('The main process returned malformed application information.');
  }

  return appInfo;
};

const requestDocument = async (
  channel: string,
  ...args: unknown[]
): Promise<DocumentRequestResult> => {
  const payload: unknown = await ipcRenderer.invoke(channel, ...args);
  const result = parseDocumentRequestResult(payload);

  if (result === null) {
    throw new Error('The main process returned a malformed document response.');
  }

  return result;
};

const getReaderState = async (): Promise<ReaderStateSnapshot> => {
  const payload: unknown = await ipcRenderer.invoke(IpcChannel.GetReaderState);
  const snapshot = parseReaderStateSnapshot(payload);

  if (snapshot === null) {
    throw new Error('The main process returned a malformed reader state.');
  }

  return snapshot;
};

/**
 * Looks a word up.
 *
 * A malformed reply becomes `unavailable` rather than an exception: a
 * dictionary that cannot answer must not interrupt reading.
 */
const lookUpWord = async (query: DictionaryQuery): Promise<DictionaryResult> => {
  const payload: unknown = await ipcRenderer.invoke(IpcChannel.LookUpWord, {
    normalized: query.normalized,
    raw: query.raw,
    joinedAcrossLines: query.joinedAcrossLines,
  });

  return parseDictionaryResult(payload) ?? { status: 'unavailable', reason: 'unreadable' };
};

/**
 * Asks the main process one vocabulary question.
 *
 * A reply that does not parse becomes a typed failure rather than an
 * exception: the library can show "that could not be read" and stay on
 * screen, which is more use to a reader than a stack trace.
 */
const askVocabulary = async <T>(
  channel: string,
  payload: unknown,
  parse: (value: unknown) => VocabularyIpcResult<T> | null,
): Promise<VocabularyIpcResult<T>> => {
  const reply: unknown = await ipcRenderer.invoke(channel, payload);

  return parse(reply) ?? { ok: false, error: { kind: 'unavailable', reason: 'unknown' } };
};

const vocabulary: VocabularyBridge = {
  stateForWord: async (request: StateForWordRequest) =>
    askVocabulary(IpcChannel.VocabularyStateForWord, request, parseStateResult),
  save: async (request: SaveWordIpcRequest) =>
    askVocabulary(IpcChannel.VocabularySave, request, parseSavedWordResult),
  remove: async (itemId: string) =>
    askVocabulary(IpcChannel.VocabularyRemove, { itemId }, parseVoidResult),
  restore: async (itemId: string) =>
    askVocabulary(IpcChannel.VocabularyRestore, { itemId }, parseVoidResult),
  list: async (query: LibraryIpcQuery) =>
    askVocabulary(IpcChannel.VocabularyList, query, parseLibraryPageResult),
  search: async (query: SearchIpcQuery) =>
    askVocabulary(IpcChannel.VocabularySearch, query, parseSearchResults),
  occurrences: async (itemId: string) =>
    askVocabulary(IpcChannel.VocabularyOccurrences, { itemId }, parseOccurrencesResult),
  exportLibrary: async (format: VocabularyExportFormat) => {
    try {
      return parseVocabularyExportOutcome(
        await ipcRenderer.invoke(IpcChannel.VocabularyExport, format),
      );
    } catch {
      return { status: 'failed' } as const;
    }
  },
};

/**
 * The AI bridge: four fixed methods, no passthrough.
 *
 * A reply that does not parse becomes "nothing is configured" or a typed
 * failure, never an exception: an explanation that cannot be had must not
 * interrupt reading, and the popup keeps showing the dictionary entry.
 */
const ai: AiBridge = {
  status: async (): Promise<AiStatusReply> => {
    const payload: unknown = await ipcRenderer.invoke(IpcChannel.AiStatus);

    return parseAiStatus(payload) ?? AI_UNCONFIGURED;
  },
  storedExplanation: async (query: StoredExplanationIpcQuery) => {
    const payload: unknown = await ipcRenderer.invoke(IpcChannel.AiExplanationFor, query);

    return parseExplanationView(payload);
  },
  explain: async (request: ExplainIpcRequest) => {
    const payload: unknown = await ipcRenderer.invoke(IpcChannel.AiExplain, request);

    return parseExplanationResult(payload) ?? { ok: false, error: { kind: 'provider-error' } };
  },
  cancel: async (requestId: string): Promise<void> => {
    await ipcRenderer.invoke(IpcChannel.AiCancel, { requestId });
  },
};

const recovery: NonNullable<DesktopBridge['recovery']> = {
  listBackups: async (): Promise<
    Awaited<ReturnType<NonNullable<DesktopBridge['recovery']>['listBackups']>>
  > =>
    parseVocabularyRecoveryListResult(
      await ipcRenderer.invoke(IpcChannel.VocabularyRecoveryBackups),
    ) ?? { ok: false, error: 'blocked' as const },
  restore: async (
    backupId: string,
    confirmedBackupId: string,
  ): Promise<Awaited<ReturnType<NonNullable<DesktopBridge['recovery']>['restore']>>> =>
    parseVocabularyRecoveryRestoreResult(
      await ipcRenderer.invoke(IpcChannel.VocabularyRecoveryRestore, {
        backupId,
        confirmedBackupId,
      }),
    ) ?? { ok: false, error: 'blocked' as const },
};

/**
 * The update bridge: five fixed methods and no address.
 *
 * A reply that does not parse reads as "nothing to report": an update
 * check that went wrong must never interrupt reading.
 */
const updates: UpdateBridge = {
  check: async (manual: boolean): Promise<UpdateIpcState> =>
    parseUpdateState(
      await ipcRenderer.invoke(IpcChannel.UpdateCheck, { manual: manual === true }),
    ) ?? UPDATE_STATE_UNKNOWN,
  setAutomatic: async (automatic: boolean): Promise<UpdateIpcState> =>
    parseUpdateState(
      await ipcRenderer.invoke(IpcChannel.UpdateSetAutomatic, { automatic: automatic === true }),
    ) ?? UPDATE_STATE_UNKNOWN,
  download: async (): Promise<UpdateIpcState> =>
    parseUpdateState(await ipcRenderer.invoke(IpcChannel.UpdateDownload)) ?? UPDATE_STATE_UNKNOWN,
  install: async (): Promise<void> => {
    await ipcRenderer.invoke(IpcChannel.UpdateInstall);
  },
  openDownload: async (): Promise<void> => {
    await ipcRenderer.invoke(IpcChannel.UpdateOpenDownload);
  },
};

const desktopBridge: DesktopBridge = {
  getAppInfo,
  openDocumentDialog: async () => requestDocument(IpcChannel.OpenDocumentDialog),
  getInitialDocument: async () => requestDocument(IpcChannel.GetInitialDocument),
  openRecentDocument: async (documentId: string) =>
    requestDocument(IpcChannel.OpenRecentDocument, documentId),
  getReaderState,
  /*
   * The three channels that cause a write to disk answer with the health
   * of the last one (M7.2). The reply is parsed like every other: a main
   * process that said something unexpected is not evidence that the disk
   * is failing, so anything but the word `failing` reads as `ok`.
   */
  saveReadingPosition: async (update: ReadingPositionUpdate): Promise<StateWriteHealth> =>
    parseStateWriteHealth(await ipcRenderer.invoke(IpcChannel.SaveReadingPosition, update)),
  forgetDocument: async (documentId: string): Promise<StateWriteHealth> =>
    parseStateWriteHealth(await ipcRenderer.invoke(IpcChannel.ForgetDocument, documentId)),
  /*
   * The four settings, sent field by field rather than as whatever object
   * the caller happened to hold: the bridge decides what crosses, so a
   * property added to a renderer-side object by accident — or on purpose —
   * cannot ride along to the main process.
   */
  savePreferences: async (preferences: Preferences): Promise<StateWriteHealth> => {
    const reply: unknown = await ipcRenderer.invoke(IpcChannel.SavePreferences, {
      appearance: preferences.appearance,
      reduceMotion: preferences.reduceMotion,
      defaultZoomMode: preferences.defaultZoomMode,
      showDeveloperDiagnostics: preferences.showDeveloperDiagnostics,
    });

    return parseStateWriteHealth(reply);
  },
  lookUpWord,
  vocabulary,
  ai,
  recovery,
  updates,
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, desktopBridge);

/*
 * Dropping a PDF onto the window opens it.
 *
 * Handled here rather than in the page so that no function taking a path
 * has to be exposed to it. Only a genuine drop is acted on (`isTrusted`:
 * a script cannot fabricate one), only a single file, and the path is the
 * one Electron reports for that file — empty for anything that is not a
 * file on disk. The main process checks the path again and decides.
 *
 * Both events are always cancelled when files are involved: Chromium's
 * own answer to a dropped file is to navigate the window to it.
 */
/* The preload is compiled without the DOM library; this is all it needs. */
interface DroppedFiles {
  readonly length: number;
  readonly [index: number]: File | undefined;
}

interface FileDragEvent {
  readonly isTrusted: boolean;
  readonly dataTransfer: { readonly types: readonly string[]; readonly files: DroppedFiles } | null;
  preventDefault(): void;
}

const page = globalThis as unknown as {
  addEventListener(type: 'dragover' | 'drop', listener: (event: FileDragEvent) => void): void;
};

const carriesFiles = (event: FileDragEvent): boolean =>
  event.dataTransfer?.types.includes('Files') === true;

page.addEventListener('dragover', (event) => {
  if (carriesFiles(event)) {
    event.preventDefault();
  }
});

page.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) {
    return;
  }

  event.preventDefault();

  const files = event.dataTransfer?.files;
  const file = files?.length === 1 ? files[0] : undefined;

  if (!event.isTrusted || file === undefined) {
    return;
  }

  const path = webUtils.getPathForFile(file);

  if (path !== '') {
    void ipcRenderer.invoke(IpcChannel.OpenDroppedDocument, path).catch(() => {
      // Nothing to tell the page: the window simply stays as it was.
    });
  }
});
