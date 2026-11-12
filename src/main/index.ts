import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  access,
  open as openFile,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron';
import packageMetadata from '../../package.json';

import type { DocumentRequestResult } from '@shared/ipc/contracts';

import {
  CONFIGURATION_FILE,
  AI_FEATURE_ENABLED,
  loadAiConfiguration,
  type ConfigurationFileContents,
} from './ai/configuration';
import { createExplanationService } from './ai/explanationService';
import { createNotConfiguredExplainer } from './ai/providers/notConfigured';
import { createOpenAiCompatibleExplainer } from './ai/providers/openAiCompatible';
import { resolveArtifactDirectory } from './dictionary/artifactLocation';
import { createDictionaryService } from './dictionary/dictionaryService';
import { openFileArtifact, MANIFEST_FILE } from './dictionary/fileArtifact';
import { readDocumentFile, type FileSystemAccess } from './documents/documentFile';
import { parseDocumentArgument } from './documents/initialDocument';
import { claimSingleInstance } from './lifecycle/singleInstance';
import { createQuitFlush } from './lifecycle/quitFlush';
import { createForwardedDocumentQueue } from './lifecycle/forwardedDocuments';
import {
  installProcessGuards,
  reportBootstrapFailure,
  reportTerminalRendererLoss,
} from './lifecycle/processGuards';

import { resolveDevServerOrigin } from './environment';
import { createAppInfo } from './ipc/appInfo';
import { registerAiIpcHandlers } from './ipc/registerAiIpcHandlers';
import { registerAppIpcHandlers } from './ipc/registerAppIpcHandlers';
import { registerDictionaryIpcHandlers } from './ipc/registerDictionaryIpcHandlers';
import { registerDocumentIpcHandlers } from './ipc/registerDocumentIpcHandlers';
import { registerStateIpcHandlers } from './ipc/registerStateIpcHandlers';
import { registerVocabularyIpcHandlers } from './ipc/registerVocabularyIpcHandlers';
import { registerUpdateIpcHandlers } from './ipc/registerUpdateIpcHandlers';
import { registerVocabularyRecoveryIpcHandlers } from './ipc/registerVocabularyRecoveryIpcHandlers';
import { createReaderStateStore } from './persistence/readerStateStore';
import { applyWebContentsSecurityPolicies } from './security/navigationPolicy';
import { applySessionSecurityPolicies } from './security/sessionPolicy';
import { createReaderStateService } from './state/readerStateService';
import { createTransformVersionReader } from './vocabulary/artifactVersion';
import {
  openVocabularyDatabase,
  classifyDatabaseError,
  VocabularyOpenError,
} from './vocabulary/connection';
import { createVocabularyDatabaseRuntime } from './vocabulary/vocabularyDatabaseRuntime';
import { createVocabularyBackupCoordinator } from './vocabulary/vocabularyBackupCoordinator';
import { migrateWithVerifiedBackups } from './vocabulary/destructiveMigrationCoordinator';
import { createVocabularyRestoreCoordinator } from './vocabulary/vocabularyRestoreCoordinator';
import { createVocabularyMaintenanceGate } from './vocabulary/vocabularyMaintenanceGate';
import { inspectVocabularyRecovery } from './vocabulary/vocabularyRecovery';
import { vocabularyDatabasePath } from './vocabulary/databaseFile';
import { createExplanationStore } from './vocabulary/explanationStore';
import { createSqliteVocabularyRepository } from './vocabulary/sqliteVocabularyRepository';
import { createVocabularyService } from './vocabulary/vocabularyService';
import type { WindowThemeController } from './theme/windowTheme';
import {
  canInstallUpdates,
  createElectronUpdaterInstaller,
  type AutoUpdaterLike,
} from './update/updateInstaller';
import {
  ORPHANED_ZYGOTE_SWEEP_INTERVAL_MS,
  parseProcessStat,
  stopOrphanedZygotes,
  type ProcessTable,
} from './lifecycle/orphanedZygotes';
import { createUpdateService } from './update/updateService';
import { UPDATE_SETTINGS_FILE, createUpdateSettingsStore } from './update/updateSettings';
import { createMainWindow } from './window/createMainWindow';
import { createRendererRecovery } from './window/rendererRecovery';

const LOG_PREFIX = '[main]';

const PRELOAD_PATH = join(__dirname, '../preload/index.js');
const RENDERER_ENTRY_PATH = join(__dirname, '../renderer/index.html');

/** How long the update check waits for an answer before giving up. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** Name of the reading-state document inside the per-user data directory. */
const READER_STATE_FILE = 'reader-state.json';

/**
 * Reads the optional AI provider file, synchronously and with its mode.
 *
 * The mode is read in the same call as the contents because the loader
 * refuses a file other users can read, and a permission check that happens
 * a moment before the read is a check of a different file.
 */
const readAiConfigurationFile = (path: string): ConfigurationFileContents | null => {
  try {
    return { contents: readFileSync(path, 'utf8'), mode: statSync(path).mode };
  } catch {
    return null;
  }
};

const openExternalUrl = (url: string): void => {
  void shell.openExternal(url);
};

const fileSystem: FileSystemAccess = {
  stat: async (path) => stat(path),
  readFile: async (path) => new Uint8Array(await readFile(path)),
};

/** Shows the system file chooser and returns the chosen path. */
const chooseDocumentPath = async (): Promise<string | null> => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    properties: ['openFile' as const],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  };

  const selection = await (window === undefined
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(window, options));

  const path = selection.filePaths[0];

  return selection.canceled || path === undefined ? null : path;
};

/*
 * Linux only: a Lexleaf helper process that has been left, or started,
 * with no application behind it spins forever and fills the system log.
 * Looked for at startup and every couple of minutes while running; see
 * `orphanedZygotes.ts` for the defect and for why the rule is safe.
 */
const watchForOrphanedZygotes = (): void => {
  if (process.platform !== 'linux' || !app.isPackaged) {
    return;
  }

  const table: ProcessTable = {
    list: () => readdirSync('/proc'),
    read: (pid, file) => {
      try {
        return readFileSync(`/proc/${String(pid)}/${file}`, 'utf8');
      } catch {
        return null;
      }
    },
  };
  const ownName = parseProcessStat(table.read(process.pid, 'stat'))?.name ?? '';

  const sweep = (): void => {
    stopOrphanedZygotes({
      table,
      ownName,
      ownPid: process.pid,
      kill: (pid) => {
        process.kill(pid, 'SIGKILL');
      },
      onDiagnostic: (message) => {
        console.warn(`${LOG_PREFIX} ${message}`);
      },
    });
  };

  sweep();
  // Never the reason the application stays open.
  setInterval(sweep, ORPHANED_ZYGOTE_SWEEP_INTERVAL_MS).unref();
};

const bootstrap = async (): Promise<void> => {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;

  watchForOrphanedZygotes();

  /*
   * The window the recovery acts on. It is a variable rather than a
   * parameter because the recovery outlives any one window: the whole
   * point is that it reloads the one that died (M7.1, ADR-035).
   */
  let mainWindow: BrowserWindow | null = null;

  const recovery = createRendererRecovery({
    reload: () => {
      // `reloadIgnoringCache` would be a different promise than the one
      // made: this is the same document the reader already had.
      mainWindow?.webContents.reload();
    },
    onTerminalFailure: () => {
      /*
       * There is no renderer left to put a message in, so the only
       * honest surface is the native one — and the dead window goes
       * *first*. `showErrorBox` blocks until the box is dismissed, so
       * showing it before destroying the window left a painted,
       * working-looking reader sitting underneath it: exactly the defect
       * R1 described, found on screen by the M7.1 audit (C-1).
       * `reportTerminalRendererLoss` owns that ordering and is tested on
       * it. Nothing is reloaded and nothing is retried.
       */
      const dead = mainWindow;
      mainWindow = null;

      reportTerminalRendererLoss({
        destroyWindow: () => {
          if (dead !== null && !dead.isDestroyed()) {
            dead.destroy();
          }
        },
        showErrorBox: (title, content) => {
          dialog.showErrorBox(title, content);
        },
        onDiagnostic: (message) => {
          console.warn(`${LOG_PREFIX} ${message}`);
        },
      });
    },
    onDiagnostic: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
  });
  const devServerOrigin = resolveDevServerOrigin(devServerUrl ?? undefined);

  applySessionSecurityPolicies(session.defaultSession, devServerOrigin);

  app.on('web-contents-created', (_event, contents) => {
    applyWebContentsSecurityPolicies(contents, { devServerOrigin, openExternal: openExternalUrl });
  });

  const readerState = createReaderStateService({
    store: createReaderStateStore({
      filePath: join(app.getPath('userData'), READER_STATE_FILE),
      files: {
        readFile: async (path) => readFile(path, 'utf8'),
        writeFile: async (path, contents) => writeFile(path, contents, 'utf8'),
        rename: async (from, to) => rename(from, to),
        /*
         * M7.3, R7. `writeFile` returns when the kernel has the bytes,
         * not when the device does, so a rename immediately afterwards
         * can publish a name whose contents are still only in the page
         * cache. `fdatasync` closes that window for the temporary file
         * before it becomes the real one.
         */
        syncFile: async (path) => {
          const handle = await openFile(path, 'r+');

          try {
            await handle.datasync();
          } finally {
            await handle.close();
          }
        },
        /*
         * The rename itself is a directory operation, so the directory
         * entry needs flushing too for the new name to survive a power
         * cut. Opening a directory for this is a POSIX convenience that
         * is not portable — on Windows it throws — which is why the
         * store treats a failure here as a diagnostic and nothing more.
         */
        syncDirectory: async (path) => {
          const handle = await openFile(path, 'r');

          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
        remove: async (path) => unlink(path),
      },
      onWarning: (message) => {
        console.warn(`${LOG_PREFIX} ${message}`);
      },
    }),
    /*
     * Where the detail of a failed open goes (M7.2, ADR-034). The reader
     * is told which of five things went wrong; the `errno`, the exception
     * and the path itself are written here, in the main process, which is
     * the only place they exist.
     */
    readDocument: async (path) =>
      readDocumentFile(path, fileSystem, {
        onDiagnostic: (message) => {
          console.warn(`${LOG_PREFIX} ${message}`);
        },
      }),
    exists: async (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    now: () => new Date(),
    /*
     * The renderer learns that it is a replacement from the state it
     * already asks for at startup (M7.1). No channel was added for it,
     * and the value is one of two words.
     */
    sessionRecovery: () => recovery.notice(),
  });

  // The dictionary is opened lazily on the first lookup, but the attempt is
  // started here so that a broken installation is reported in the log at
  // launch rather than on the reader's first double-click.
  // Resolved once and shared: the dictionary reads the artifact, and the
  // vocabulary reads one field out of its manifest to record which build of
  // it a saved definition came from.
  const locateArtifact = (): string | null =>
    resolveArtifactDirectory(
      {
        appPath: app.getAppPath(),
        resourcesPath: app.isPackaged ? process.resourcesPath : null,
        packaged: app.isPackaged,
      },
      (directory) => existsSync(join(directory, MANIFEST_FILE)),
    );

  const dictionary = createDictionaryService({
    locate: locateArtifact,
    open: openFileArtifact,
    onDiagnostic: (message) => {
      console.info(`${LOG_PREFIX} ${message}`);
    },
  });

  dictionary.prepare();

  /*
   * The vocabulary is opened on the first save or the first visit to the
   * library, never at startup: a reader whose profile directory is not
   * writable still gets a reader and a dictionary (Principle 7).
   */
  // One connection, opened at most once, shared by the two things that
  // write to it: a word and the explanations that belong to it have to be
  // removed and restored inside a single transaction, which two
  // connections could not do.
  const backupCoordinator = createVocabularyBackupCoordinator({
    userDataPath: app.getPath('userData'),
    applicationVersion: app.getVersion(),
  });
  const vocabularyPath = vocabularyDatabasePath(app.getPath('userData'));
  const recoveryInspection = await inspectVocabularyRecovery(vocabularyPath, backupCoordinator);
  for (const artifact of recoveryInspection.artifacts) {
    if (!['valid-published', 'quarantined'].includes(artifact.status)) {
      try {
        await backupCoordinator.quarantine(artifact.name, artifact.reason ?? artifact.status);
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} backup quarantine failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
  }

  const vocabularyGate = createVocabularyMaintenanceGate();
  const databaseRuntime = createVocabularyDatabaseRuntime({
    open: () => {
      if (recoveryInspection.decision !== 'normal') {
        throw new VocabularyOpenError(
          'recovery-required',
          'vocabulary recovery inspection requires operator action',
        );
      }
      return openVocabularyDatabase({
        filePath: vocabularyPath,
        migrate: false,
        onDiagnostic: (message) => {
          console.info(`${LOG_PREFIX} ${message}`);
        },
      }).database;
    },
    prepare: async (database): Promise<void> => {
      await migrateWithVerifiedBackups(database, {
        backup: backupCoordinator,
        onDiagnostic: (message) => console.info(`${LOG_PREFIX} ${message}`),
      });
    },
    close: (database) => database.close(),
    classifyFailure: classifyDatabaseError,
  });

  const restoreCoordinator = createVocabularyRestoreCoordinator({
    userDataPath: app.getPath('userData'),
    liveDatabasePath: vocabularyPath,
    backups: backupCoordinator,
    closeRuntime: () => databaseRuntime.close(),
    openRuntime: async () => {
      databaseRuntime.reopen();
      await databaseRuntime.ensureReady();
    },
  });

  const preparedDatabase = () => {
    const database = databaseRuntime.connection();

    if (database === null) {
      throw new Error('vocabulary database was used before readiness');
    }

    return database;
  };

  let explanationStore: ReturnType<typeof createExplanationStore> | null = null;
  const sharedExplanationStore = () =>
    (explanationStore ??= createExplanationStore({ database: preparedDatabase() }));

  const vocabulary = createVocabularyService({
    open: () => createSqliteVocabularyRepository({ database: preparedDatabase() }),
    openExplanations: sharedExplanationStore,
    onDiagnostic: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
  });

  const transformVersion = createTransformVersionReader(locateArtifact);

  /*
   * Contextual explanation is off unless a provider was configured outside
   * the application: an environment variable or a file only this user can
   * read. There is no in-app credential entry, and with nothing configured
   * the renderer is told so and shows no explanation control at all.
   */
  const aiConfiguration = AI_FEATURE_ENABLED
    ? loadAiConfiguration({
        env: process.env,
        readConfigurationFile: () =>
          readAiConfigurationFile(join(app.getPath('userData'), CONFIGURATION_FILE)),
        onDiagnostic: (message) => {
          console.info(`${LOG_PREFIX} ${message}`);
        },
      })
    : null;

  const explanations = createExplanationService({
    explainer:
      aiConfiguration === null
        ? createNotConfiguredExplainer()
        : createOpenAiCompatibleExplainer({
            configuration: aiConfiguration,
            // Electron's own stack, so the request is subject to the
            // session's policies rather than Node's defaults (D3).
            fetchImpl: (url, init) => net.fetch(url, init),
            nonce: () => randomUUID(),
            onDiagnostic: (message) => {
              console.info(`${LOG_PREFIX} ${message}`);
            },
          }),
    configured: aiConfiguration !== null,
    providerId: aiConfiguration?.providerId ?? 'none',
    modelId: aiConfiguration?.modelId ?? 'none',
    store: () => {
      try {
        return sharedExplanationStore();
      } catch {
        // No database means no durable explanation, never no reading.
        return null;
      }
    },
    resolveItemId: (normalized, documentId, page) => {
      const state = vocabulary.stateForWord(normalized, documentId, page);

      return state.ok && state.value.state !== 'not-saved' ? state.value.itemId : null;
    },
    lookUp: (query) => dictionary.lookUp(query),
    onDiagnostic: (message) => {
      console.info(`${LOG_PREFIX} ${message}`);
    },
  });

  /*
   * The document this process has been asked to show. It starts as the
   * one named on our own command line and is replaced when a later launch
   * forwards one (M7.3). `initialDocument` is the existing open pipeline
   * and stays the only one: a forwarded request is answered by pointing
   * this at the new path and reloading the window, so the renderer asks
   * the same question it asks at startup and gets the new answer. No
   * second loading mechanism, no new channel, no extra window.
   */
  let requestedDocumentPath = parseDocumentArgument(process.argv);

  /*
   * Forwarded documents are delivered one at a time (C-1). The completion
   * signal is the renderer's own `initialDocument` request below — the
   * request that actually opens the document — so serializing costs no
   * new channel and no new renderer API.
   */
  const forwardedDocuments = createForwardedDocumentQueue({
    deliver: async (path: string): Promise<void> => {
      requestedDocumentPath = path;

      /*
       * The pending write goes out first: reloading discards whatever the
       * renderer is holding, and the reading position of the document
       * being replaced must not be the casualty of opening another one.
       */
      await readerState.flush();

      const window = mainWindow;

      if (window === null || window.isDestroyed()) {
        await openMainWindow();

        return;
      }

      revealWindow(window);
      window.webContents.reload();
    },
    onDiagnostic: (message) => {
      console.info(`${LOG_PREFIX} ${message}`);
    },
  });

  registerDocumentIpcHandlers(ipcMain, {
    chooseDocument: async (): Promise<DocumentRequestResult> => {
      const path = await chooseDocumentPath();

      return path === null ? { status: 'none' } : readerState.openPath(path);
    },
    initialDocument: async (): Promise<DocumentRequestResult> => {
      /*
       * Taken before the path is read and completed after the open has
       * finished: this is the point at which a forwarded request has been
       * consumed and a later reload can no longer supersede it (C-1).
       */
      const ticket = forwardedDocuments.beginInitialDocumentRequest();

      try {
        return requestedDocumentPath === null
          ? { status: 'none' }
          : await readerState.openPath(requestedDocumentPath);
      } finally {
        forwardedDocuments.completeInitialDocumentRequest(ticket);
      }
    },
    openRecentDocument: async (documentId) => readerState.openRecent(documentId),
    devServerOrigin,
  });

  /*
   * The window's own appearance, kept here because the main process owns
   * the native surface (ADR-030) and the stored preference is the only
   * thing that may change it (ADR-031). There is no theme message from the
   * renderer: the settings panel saves a preference, and this is the main
   * process reading its own stored state back.
   */
  let mainWindowTheme: WindowThemeController | null = null;

  registerStateIpcHandlers(ipcMain, {
    snapshot: async () => readerState.snapshot(),
    savePosition: async (update) => readerState.savePosition(update),
    forgetDocument: async (documentId) => readerState.forget(documentId),
    savePreferences: async (preferences) => {
      const health = await readerState.savePreferences(preferences);

      mainWindowTheme?.apply(preferences.appearance);

      return health;
    },
    onRejected: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
    devServerOrigin,
  });

  registerDictionaryIpcHandlers(ipcMain, {
    lookUp: (query) => dictionary.lookUp(query),
    onRejected: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
    devServerOrigin,
  });

  registerVocabularyIpcHandlers(ipcMain, {
    service: vocabulary,
    describeDocument: async (documentId) => {
      const known = await readerState.describe(documentId);

      return known === null
        ? null
        : {
            id: known.id,
            name: known.name,
            path: known.path,
            pageCount: known.pageCount,
            sizeBytes: known.sizeBytes,
          };
    },
    transformVersion,
    // An explanation the reader already has in front of them becomes
    // durable when they save the word, and only then.
    afterSave: (saved, place) => {
      explanations.promote({
        itemId: saved.id,
        normalized: saved.word.normalized,
        documentId: place.documentId,
        page: place.page,
      });
    },
    onRejected: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
    devServerOrigin,
    ensureReady: () => databaseRuntime.ensureReady(),
    enterOperation: vocabularyGate.enter,
  });

  registerAiIpcHandlers(ipcMain, {
    service: explanations,
    onRejected: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
    devServerOrigin,
    ensureReady: () => databaseRuntime.ensureReady(),
    enterOperation: vocabularyGate.enter,
    enabled: AI_FEATURE_ENABLED,
  });

  registerVocabularyRecoveryIpcHandlers(ipcMain, {
    backups: backupCoordinator,
    restore: restoreCoordinator,
    recoveryPermitted: () => recoveryInspection.decision !== 'normal',
    gate: vocabularyGate,
    onRestoreStart: async () => {},
    onRestoreComplete: async () => {},
    onRejected: (message) => console.warn(`${LOG_PREFIX} ${message}`),
    devServerOrigin,
  });

  /*
   * Updates. The application tells the reader a newer release exists;
   * downloading it and installing it each wait for the reader to ask.
   * The check is the only request the application makes without being asked,
   * the reader can turn it off, and it carries nothing about them: no
   * body, no identifier, no stored credentials.
   */
  const updates = createUpdateService({
    currentVersion: app.getVersion(),
    settings: createUpdateSettingsStore({
      filePath: join(app.getPath('userData'), UPDATE_SETTINGS_FILE),
      files: {
        readFile: async (path) => readFile(path, 'utf8'),
        writeFile: async (path, contents) => writeFile(path, contents, 'utf8'),
      },
      onDiagnostic: (message) => {
        console.warn(`${LOG_PREFIX} ${message}`);
      },
    }),
    fetchLatestRelease: async (address) => {
      const response = await net.fetch(address, {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`update check answered ${String(response.status)}`);
      }

      return (await response.json()) as unknown;
    },
    openExternal: openExternalUrl,
    now: () => new Date(),
    // A development build is not something a reader installed: it stays
    // quiet unless the check is asked for by hand.
    automaticChecksAllowed: app.isPackaged,
    /*
     * Only a Windows installation and a Linux AppImage can replace
     * themselves. Everything else — a Debian package, a development
     * build — gets the notice and the download page instead.
     */
    installer: canInstallUpdates({
      packaged: app.isPackaged,
      platform: process.platform,
      env: process.env,
    })
      ? createElectronUpdaterInstaller({
          currentVersion: app.getVersion(),
          // Loaded on first use, so a build in which the library fails to
          // load still starts and still offers the download page.
          load: async () => (await import('electron-updater')).autoUpdater as AutoUpdaterLike,
          onDiagnostic: (message) => {
            console.info(`${LOG_PREFIX} ${message}`);
          },
        })
      : null,
    // The reader's place is written out before the application is closed
    // to install: the installer does not wait for a debounced write.
    beforeInstall: async () => {
      await readerState.flush();
    },
    onDiagnostic: (message) => {
      console.info(`${LOG_PREFIX} ${message}`);
    },
  });

  registerUpdateIpcHandlers(ipcMain, {
    service: updates,
    onRejected: (message) => {
      console.warn(`${LOG_PREFIX} ${message}`);
    },
    devServerOrigin,
  });

  registerAppIpcHandlers(ipcMain, {
    appInfo: createAppInfo({
      name: packageMetadata.productName,
      version: packageMetadata.version,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    }),
    devServerOrigin,
  });

  // A reading position recorded a moment before quitting is the one that
  // matters most, so the debounced write is forced out before the process
  // goes away.
  const quitFlush = createQuitFlush({
    /*
     * The store reports a failed write through its health rather than by
     * rejecting — a write failure is diagnosed, never thrown at a caller
     * (M7.2) — so the quit coordinator is told the outcome explicitly
     * instead of inferring success from a promise that always resolves
     * (C-2).
     */
    flush: async () => ((await readerState.flush()) === 'ok' ? 'saved' : 'not-saved'),
    quit: () => {
      app.quit();
    },
    onDiagnostic: (message) => {
      console.info(`${LOG_PREFIX} ${message}`);
    },
  });

  app.on('before-quit', (event) => {
    /*
     * The debounced write is forced out *and waited for* before the
     * process goes away (M7.3, L1). The handler cancels this first quit,
     * flushes, and quits again; the second pass is let through.
     */
    quitFlush.onBeforeQuit(event);

    if (quitFlush.phase() === 'done') {
      dictionary.close();
      explanations.close();
      vocabulary.close();
      databaseRuntime.close();
    }
  });

  const openMainWindow = async (): Promise<void> => {
    /*
     * Read before the window exists, because the background colour is a
     * constructor argument: resolving it afterwards is what produces the
     * wrong-coloured first frame ADR-030 exists to prevent. A state file
     * that cannot be read answers with the defaults, so a broken
     * preferences block still opens a window.
     */
    const { appearance } = await readerState.preferences();

    const { window, theme } = await createMainWindow({
      preloadPath: PRELOAD_PATH,
      rendererEntryPath: RENDERER_ENTRY_PATH,
      devServerUrl,
      appearance,
      onReady: () => {
        console.info(`${LOG_PREFIX} main window ready`);
        // A window that painted is a renderer that works, which is what
        // ends a recovery (M7.1).
        recovery.onRendererReady();
      },
      onLoadFailure: (reason) => {
        console.error(`${LOG_PREFIX} renderer failed to load: ${reason}`);
      },
    });

    mainWindow = window;
    mainWindowTheme = theme;

    /*
     * The three events R1 found nobody listening for. They are
     * registered on the window's own `webContents`, so they go away with
     * the window and a reload does not accumulate a second set.
     *
     * `child-process-gone` is deliberately **not** among them. It
     * reports utility and GPU processes, which Chromium restarts itself
     * and which do not leave the reader with a dead window; registering
     * it would mean either ignoring it — a handler that does nothing —
     * or reloading the reader for something that did not break it.
     * `render-process-gone` is the event that corresponds to the defect.
     */
    window.webContents.on('render-process-gone', (_event, details) => {
      recovery.onRendererGone({ reason: details.reason, exitCode: details.exitCode });
    });

    /*
     * `ready-to-show` above fires once per window and therefore never
     * again after a recovery reload, which left the state machine stuck
     * in `recovering`. `did-finish-load` is the signal that corresponds
     * to "this renderer loaded the application again": it fires for the
     * first load too, which is harmless because `onRendererReady` only
     * does something while a recovery is in flight. Found by the M7.1
     * runtime scenario, not by a unit test.
     */
    window.webContents.on('did-finish-load', () => {
      recovery.onRendererReady();
    });

    window.on('unresponsive', () => {
      recovery.onUnresponsive();
    });

    window.on('responsive', () => {
      recovery.onResponsive();
    });
  };

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openMainWindow();
    }
  });

  /*
   * A later launch handed us its command line (M7.3, R4). This process
   * stays the only writer and the only window; the forwarded request is
   * answered by the pipeline that already answers `--open-document` at
   * startup, and queued behind any request still being opened (C-1).
   */
  forwardDocument = (path: string): void => {
    forwardedDocuments.enqueue(path);
  };

  focusExistingWindow = (): void => {
    const window = mainWindow;

    if (window === null || window.isDestroyed()) {
      void openMainWindow();

      return;
    }

    revealWindow(window);
  };

  await openMainWindow();
};

/*
 * Set by `bootstrap`, called by the single-instance handler. The claim has
 * to be made before `whenReady` — a process that lost it must not reach
 * `bootstrap` at all — so the handler is registered first and finds its
 * behaviour here once there is something to forward to.
 */
let forwardDocument: ((path: string) => void) | null = null;
let focusExistingWindow: (() => void) | null = null;

const revealWindow = (window: BrowserWindow): void => {
  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/*
 * R4. One writer, enforced by Electron's own lock, before anything reads
 * or writes `reader-state.json`. A process that does not own the lock
 * forwards its command line and exits without creating a window.
 */
const claim = claimSingleInstance({
  app,
  onForwardedDocument: (path) => {
    forwardDocument?.(path);
  },
  onFocusRequested: () => {
    focusExistingWindow?.();
  },
  onDiagnostic: (message) => {
    console.info(`${LOG_PREFIX} ${message}`);
  },
});

/*
 * The last resort (M7.1, ADR-035, R9). Installed before anything is
 * started, because a failure during start-up is exactly the kind these
 * are for. They do not keep a broken process alive: they make sure it
 * does not die quietly.
 */
installProcessGuards({
  onDiagnostic: (message) => {
    console.error(`${LOG_PREFIX} ${message}`);
  },
  terminate: (code) => {
    app.exit(code);
  },
});

void (claim.isOwner ? app.whenReady() : Promise.resolve())
  .then(async () => {
    if (!claim.isOwner) {
      return;
    }

    await bootstrap();
  })
  .catch((error: unknown) => {
    console.error(`${LOG_PREFIX} failed to start:`, error);

    /*
     * `app.isReady()` is the honest test for whether a native box can be
     * drawn at all. Before it, there is no promise worth making about a
     * visible failure and the log says so rather than claiming one
     * (M7.1 §6). There is no second bootstrap: whatever failed will
     * fail again.
     */
    reportBootstrapFailure({
      onDiagnostic: (message) => {
        console.error(`${LOG_PREFIX} ${message}`);
      },
      showErrorBox: app.isReady()
        ? (title: string, content: string): void => {
            dialog.showErrorBox(title, content);
          }
        : null,
      terminate: (code) => {
        app.exit(code);
      },
    });
  });
