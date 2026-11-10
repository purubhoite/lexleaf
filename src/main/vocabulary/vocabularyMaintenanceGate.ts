export type MaintenanceState = 'open' | 'restoring' | 'blocked';

export interface VocabularyMaintenanceGate {
  readonly state: () => MaintenanceState;
  /** Admission for one database operation; null means refused. */
  readonly enter: () => (() => void) | null;
  /** Begins maintenance only when no operation is active. */
  readonly beginRestore: () => boolean;
  /** Reopens only after a fully validated successful restore. */
  readonly finishRestore: (success: boolean) => void;
  readonly active: () => number;
}

export const createVocabularyMaintenanceGate = (): VocabularyMaintenanceGate => {
  let mode: MaintenanceState = 'open';
  let operations = 0;
  return {
    state: () => mode,
    active: () => operations,
    enter: () => {
      if (mode !== 'open') return null;
      operations += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          operations -= 1;
        }
      };
    },
    beginRestore: () => {
      if (mode !== 'open' || operations !== 0) return false;
      mode = 'restoring';
      return true;
    },
    finishRestore: (success) => {
      mode = success ? 'open' : 'blocked';
    },
  };
};
