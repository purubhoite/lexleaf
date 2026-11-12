import { useCallback, useState } from 'react';

import { PAGE_LAYOUT_MODES, type PageLayoutMode } from './model/pageLayout';

/**
 * How pages are set out — one long column, a page at a time, or two side
 * by side — remembered on this computer between sessions.
 */
export const VIEW_MODE_STORAGE_KEY = 'lexleaf.view.mode';

const read = (): PageLayoutMode => {
  try {
    const stored = globalThis.localStorage.getItem(VIEW_MODE_STORAGE_KEY);

    return PAGE_LAYOUT_MODES.find((mode) => mode === stored) ?? 'continuous';
  } catch {
    return 'continuous';
  }
};

export const useViewMode = (): readonly [PageLayoutMode, (mode: PageLayoutMode) => void] => {
  const [mode, setMode] = useState<PageLayoutMode>(read);

  const change = useCallback((next: PageLayoutMode): void => {
    setMode(next);

    try {
      globalThis.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
    } catch {
      // Used for this session only; nothing else depends on it.
    }
  }, []);

  return [mode, change];
};
