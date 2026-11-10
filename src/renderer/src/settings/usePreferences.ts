import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_PREFERENCES,
  type PreferenceKey,
  type Preferences,
} from '@core/persistence/preferences';
import type { DesktopBridge, StateWriteHealth } from '@shared/ipc/contracts';

import { applyAppearance } from '../theme/applyAppearance';
import { applyMotion } from '../theme/applyMotion';

/**
 * The four preferences, as the renderer holds them (ADR-031).
 *
 * This hook is the renderer's single copy of that state, and the only
 * place that writes it. Three things follow from being single:
 *
 * - **one theme mechanism, one motion mechanism.** A change writes
 *   `data-theme` and `data-motion` through the same two functions
 *   `main.tsx` calls at startup (ADR-030, ADR-032). There is no second
 *   palette, no second motion switch, and still no `matchMedia` anywhere
 *   in the renderer: `system` continues to mean \"let the cascade answer\";
 * - **the attributes change before the write finishes.** A preference is
 *   applied to the document immediately and sent to the main process
 *   afterwards. Waiting for the disk would make a reader who chose
 *   \"Reduce motion: always\" watch an animation while their choice was
 *   being saved;
 * - **a failed write never interrupts.** It matches how a reading
 *   position is saved (ADR-016): the application has already done what
 *   the reader asked on screen, and an error dialog about a settings
 *   file would interrupt reading to report something the reader cannot
 *   act on. What M7.2 changed is the silence, not the rule — the save
 *   answers with the health of the write, and the shell shows one
 *   dismissible notice if it is failing (ADR-034). Without that, a
 *   preference that was never stored looked exactly like one that was,
 *   until the next launch.
 *
 * The main process keeps its own half — the native window background —
 * because it owns the window. It learns of a change from the preference it
 * was sent, not from a theme message: there is exactly one channel here,
 * and it carries preferences.
 */

export interface PreferenceControls {
  readonly preferences: Preferences;
  /** Changes one preference. Applies it, then stores it. */
  readonly set: <K extends PreferenceKey>(key: K, value: Preferences[K]) => void;
}

/** Writes the two preferences the cascade reads onto the document element. */
const applyToDocument = (preferences: Preferences): void => {
  applyAppearance(document.documentElement, preferences.appearance);
  applyMotion(document.documentElement, preferences.reduceMotion);
};

export const usePreferences = (
  bridge: DesktopBridge | null,
  onWriteHealth?: (health: StateWriteHealth) => void,
): PreferenceControls => {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  /*
   * The same value, readable without re-creating `set` on every change.
   * It also keeps the updater pure: applying an attribute or sending a
   * message from inside a state updater would run twice under
   * StrictMode's double invocation, and "saved twice" is not a property
   * worth discovering in a packaged build.
   */
  const latest = useRef<Preferences>(DEFAULT_PREFERENCES);
  /*
   * Whether the reader has already chosen something. The first read is
   * asynchronous, and a reader who opens settings and picks "dark" while
   * it is still in flight must not have their choice overwritten by the
   * value that was stored a moment ago.
   */
  const chosen = useRef(false);

  // Read once, when the bridge appears. The stored value is already
  // validated on both sides of the boundary, so whatever arrives here is
  // one of the enumerated values; a read that fails leaves the defaults,
  // which is the same state the application started in.
  useEffect(() => {
    if (bridge === null) {
      return;
    }

    let cancelled = false;

    void bridge.getReaderState().then(
      (snapshot) => {
        if (cancelled || chosen.current) {
          return;
        }

        latest.current = snapshot.preferences;
        setPreferences(snapshot.preferences);
        applyToDocument(snapshot.preferences);
      },
      () => undefined,
    );

    return (): void => {
      cancelled = true;
    };
  }, [bridge]);

  const set = useCallback(
    <K extends PreferenceKey>(key: K, value: Preferences[K]): void => {
      const next: Preferences = { ...latest.current, [key]: value };

      chosen.current = true;
      latest.current = next;
      applyToDocument(next);
      setPreferences(next);

      void bridge?.savePreferences(next).then(
        (health) => {
          onWriteHealth?.(health);
        },
        () => undefined,
      );
    },
    [bridge, onWriteHealth],
  );

  return { preferences, set };
};
