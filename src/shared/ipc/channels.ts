/**
 * Single source of truth for the IPC channel names shared by the main process,
 * the preload bridge and (indirectly) the renderer.
 *
 * Channels must stay narrow and purpose-specific. Generic channels such as
 * `execute`, `readFile` or `writeFile` are forbidden by the security baseline
 * documented in docs/ARCHITECTURE.md.
 */
export const IpcChannel = {
  /** Returns static, non-sensitive information about the running application. */
  GetAppInfo: 'app:get-info',
  /**
   * Opens a prefilled "new issue" page in the reader's browser. Takes
   * nothing: the address is built in the main process.
   */
  ReportProblem: 'app:report-problem',
  /** Asks the main process to show the "open PDF" dialog and read the choice. */
  OpenDocumentDialog: 'pdf:open-dialog',
  /** Returns the document named on the command line, if there was one. */
  GetInitialDocument: 'pdf:initial-document',
  /** Reopens a previously read document, identified by id rather than path. */
  OpenRecentDocument: 'pdf:open-recent',
  /**
   * Opens a PDF the reader dropped onto the window.
   *
   * Sent by the preload script itself from a real drop, never by the page:
   * no function that takes a path is exposed to the renderer.
   */
  OpenDroppedDocument: 'pdf:open-dropped',
  /** Returns the recent documents and which one was open last. */
  GetReaderState: 'state:get',
  /** Remembers where the reader is in a document. */
  SaveReadingPosition: 'state:save-position',
  /** Removes a document from the recent list. */
  ForgetDocument: 'state:forget',
  /**
   * Stores the four settings (ADR-031).
   *
   * The only channel the settings surface uses, and it accepts the four
   * enumerated fields and nothing else: there is no field here that could
   * carry a path, a URL, an endpoint, a credential or free text.
   */
  SavePreferences: 'state:save-preferences',
  /** Looks one word up in the bundled offline dictionary. */
  LookUpWord: 'dictionary:look-up',
  /** Is this word already saved, here or somewhere else? */
  VocabularyStateForWord: 'vocabulary:state-for-word',
  /** Saves the word the popup is showing, with where it was met. */
  VocabularySave: 'vocabulary:save',
  /** Removes a saved word and every place it was met. */
  VocabularyRemove: 'vocabulary:remove',
  /**
   * Puts back the word that was just removed.
   *
   * Undo needs the original timestamps, which a second save cannot produce
   * without inventing dates, so removal keeps the item in main-process
   * memory and this channel asks for it back by id.
   */
  VocabularyRestore: 'vocabulary:restore',
  /** One page of the library. */
  VocabularyList: 'vocabulary:list',
  /** Searches saved words, and the documents they can be filtered by. */
  VocabularySearch: 'vocabulary:search',
  /** Where a saved word was met, for returning to it. */
  VocabularyOccurrences: 'vocabulary:occurrences',
  /**
   * Writes the saved words to a file the reader chooses in the system's
   * save window. Takes a format name; no path crosses in either direction.
   */
  VocabularyExport: 'vocabulary:export',
  /** Lists independently validated vocabulary backups eligible for explicit restore. */
  VocabularyRecoveryBackups: 'vocabulary:recovery-backups',
  /** Explicitly restores one selected vocabulary backup after confirmation. */
  VocabularyRecoveryRestore: 'vocabulary:recovery-restore',
  /**
   * Is a provider configured, and where would an excerpt go?
   *
   * Labels only: no endpoint, no credential. With nothing configured the
   * popup shows no explanation control at all.
   */
  AiStatus: 'ai:status',
  /** An explanation that already exists for this word, place and passage. */
  AiExplanationFor: 'ai:explanation-for',
  /** Generate an explanation for the passage the reader is looking at. */
  AiExplain: 'ai:explain',
  /** Abandon a generation by request id. */
  AiCancel: 'ai:cancel',
  UpdateCheck: 'update:check',
  UpdateSetAutomatic: 'update:set-automatic',
  UpdateDownload: 'update:download',
  UpdateInstall: 'update:install',
  UpdateOpenDownload: 'update:open-download',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

const CHANNEL_NAMES: readonly string[] = Object.values(IpcChannel);

export const isKnownIpcChannel = (value: string): value is IpcChannelName =>
  CHANNEL_NAMES.includes(value);
