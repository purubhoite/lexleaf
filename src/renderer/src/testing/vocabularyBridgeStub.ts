import type { VocabularyBridge } from '@shared/ipc/contracts';

/**
 * A vocabulary bridge that answers "the store is not there".
 *
 * Tests written before Milestone 4 describe a reader that does not save
 * words; they get this stub so they keep describing exactly that, rather
 * than being rewritten around a feature they were never about. Every call
 * returns the same typed failure a missing database would produce, which
 * is also the shape those screens must survive in production.
 */
export const unavailableVocabularyBridge = (): VocabularyBridge => {
  const unavailable = (): Promise<{
    ok: false;
    error: { kind: 'unavailable'; reason: 'not-writable' };
  }> => Promise.resolve({ ok: false, error: { kind: 'unavailable', reason: 'not-writable' } });

  return {
    stateForWord: unavailable,
    save: unavailable,
    remove: unavailable,
    restore: unavailable,
    list: unavailable,
    search: unavailable,
    occurrences: unavailable,
    exportLibrary: () => Promise.resolve({ status: 'failed' }),
  };
};
