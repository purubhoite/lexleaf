import { useCallback, useState } from 'react';

/**
 * Whether to show the one-time tip about double-clicking a word.
 *
 * Looking a word up is what Lexleaf is for, and nothing on a page of a
 * book says that it can be done. The tip is shown with the first document
 * and is put away for good the first time the reader either dismisses it
 * or looks a word up — at which point they no longer need telling.
 *
 * "For good" is one flag in the window's own local storage, on this
 * computer. If storage is unavailable the tip is simply shown again next
 * time, which is the harmless way to be wrong.
 */
export const LOOKUP_HINT_STORAGE_KEY = 'lexleaf.hint.lookup.seen';

const readSeen = (): boolean => {
  try {
    return globalThis.localStorage.getItem(LOOKUP_HINT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export interface LookupHint {
  readonly visible: boolean;
  readonly dismiss: () => void;
}

export const useLookupHint = (): LookupHint => {
  const [seen, setSeen] = useState(readSeen);

  const dismiss = useCallback((): void => {
    setSeen(true);

    try {
      globalThis.localStorage.setItem(LOOKUP_HINT_STORAGE_KEY, '1');
    } catch {
      // Shown again next time; nothing else depends on it.
    }
  }, []);

  return { visible: !seen, dismiss };
};
