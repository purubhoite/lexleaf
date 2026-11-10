import type { VocabularyUnavailableReason } from '@core/vocabulary/types';

export type RuntimeState = 'unopened' | 'preparing' | 'ready' | 'failed' | 'closed';

export interface VocabularyDatabaseRuntimeOptions<T> {
  readonly open: () => T;
  readonly prepare: (connection: T) => void | Promise<void>;
  readonly close: (connection: T) => void;
  readonly classifyFailure?: (error: unknown) => VocabularyUnavailableReason;
}

export interface VocabularyDatabaseRuntime<T> {
  /** Lazily prepares and returns the one owned connection. */
  ensureReady(): Promise<T>;
  /** Returns the current lifecycle state without opening the database. */
  state(): RuntimeState;
  /** Returns the prepared connection, or null before readiness. */
  connection(): T | null;
  /** Closes the owned connection; pending preparation is rejected safely. */
  close(): void;
  /** Last classified preparation failure, if any. */
  failure(): VocabularyUnavailableReason | null;
  /** Reopens only after an explicit validated maintenance operation. */
  reopen(): void;
}

const defaultFailure = (): VocabularyUnavailableReason => 'unknown';

/**
 * Owns one lazily prepared synchronous database connection.
 *
 * Preparation is asynchronous at the lifecycle boundary, but the connection
 * returned after readiness is intentionally unchanged and may be used by
 * synchronous repositories. A failed preparation is retryable on the next
 * ensureReady call; close() permanently closes the runtime and rejects any
 * pending preparation without exposing a partial connection.
 */
export const createVocabularyDatabaseRuntime = <T>({
  open,
  prepare,
  close,
  classifyFailure = defaultFailure,
}: VocabularyDatabaseRuntimeOptions<T>): VocabularyDatabaseRuntime<T> => {
  let lifecycle: RuntimeState = 'unopened';
  let owned: T | null = null;
  let pending: Promise<T> | null = null;
  let lastFailure: VocabularyUnavailableReason | null = null;
  let closeRequested = false;
  let pendingReject: ((reason?: unknown) => void) | null = null;

  const dispose = (connection: T): void => {
    try {
      close(connection);
    } catch {
      // Cleanup is best effort; the original preparation failure remains the
      // meaningful failure reported to the caller.
    }
  };

  const start = (): Promise<T> => {
    lifecycle = 'preparing';
    lastFailure = null;

    const promise = new Promise<T>((resolve, reject) => {
      pendingReject = reject;

      let connection: T;
      try {
        connection = open();
      } catch (error) {
        lifecycle = 'failed';
        lastFailure = classifyFailure(error);
        pendingReject = null;
        reject(error);
        return;
      }

      void Promise.resolve()
        .then(() => prepare(connection))
        .then(() => {
          pendingReject = null;

          if (closeRequested || lifecycle === 'closed') {
            dispose(connection);
            reject(new Error('vocabulary database runtime was closed during preparation'));
            return;
          }

          owned = connection;
          lifecycle = 'ready';
          resolve(connection);
        })
        .catch((error: unknown) => {
          pendingReject = null;
          dispose(connection);
          lifecycle = closeRequested ? 'closed' : 'failed';
          lastFailure = classifyFailure(error);
          reject(error);
        });
    });

    pending = promise;
    // Observe settlement for cleanup without creating an unhandled rejected
    // derived promise. All callers receive the same original promise.
    void promise.then(
      () => {
        if (pending === promise) pending = null;
      },
      () => {
        if (pending === promise) pending = null;
      },
    );

    return promise;
  };

  return {
    ensureReady(): Promise<T> {
      if (lifecycle === 'closed' || closeRequested) {
        return Promise.reject(new Error('vocabulary database runtime is closed'));
      }
      if (lifecycle === 'ready' && owned !== null) return Promise.resolve(owned);
      if (pending !== null) return pending;
      return start();
    },
    state: () => lifecycle,
    connection: () => owned,
    failure: () => lastFailure,
    reopen(): void {
      if (lifecycle !== 'closed') throw new Error('vocabulary database runtime is not closed');
      closeRequested = false;
      lifecycle = 'unopened';
      lastFailure = null;
    },
    close(): void {
      if (closeRequested) return;
      closeRequested = true;
      lifecycle = 'closed';
      pendingReject?.(new Error('vocabulary database runtime closed'));
      pendingReject = null;
      pending = null;
      if (owned !== null) {
        const connection = owned;
        owned = null;
        dispose(connection);
      }
    },
  };
};
