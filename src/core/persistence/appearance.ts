/**
 * What the application looks like: the appearance value, and nothing else.
 *
 * ADR-030 needs an appearance in two processes — the renderer writes it onto
 * the document element, the main process resolves a window background from
 * it — and ADR-031 says a stored preference is parsed per field, in `core`,
 * with a fallback to its own default. This file is that one field.
 *
 * It is deliberately only the value boundary. Milestone 6.6 implements the
 * theme; the reader-state schema v2 that will *store* this, its migration,
 * the `state:save-preferences` channel and the settings panel that writes it
 * are ADR-031's and belong to 6.8. Until then the application resolves the
 * default, and both processes agree on what that means because they agree on
 * this module.
 */

/**
 * `system` follows the operating system, which the renderer resolves in CSS
 * and the main process resolves from Electron's `nativeTheme`. The other two
 * are explicit and beat the system in both processes.
 */
export type Appearance = 'system' | 'light' | 'dark';

/** Every valid value, in the order a settings surface would offer them. */
export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];

export const DEFAULT_APPEARANCE: Appearance = 'system';

/**
 * Reads an appearance out of unvalidated input.
 *
 * Anything unrecognised — a missing value, a misspelling, a number, an
 * object, a value from a newer build — becomes the default. A preference is
 * never allowed to be a reason the application does not start (ADR-031).
 */
export const parseAppearance = (value: unknown): Appearance =>
  APPEARANCES.find((candidate) => candidate === value) ?? DEFAULT_APPEARANCE;

/**
 * The appearance resolved to an actual palette.
 *
 * `system` is answered by whoever knows what the system says: CSS in the
 * renderer, `nativeTheme.shouldUseDarkColors` in the main process. Neither
 * process asks the other (ADR-030: no IPC for this).
 */
export type ResolvedTheme = 'light' | 'dark';

export const resolveAppearance = (
  appearance: Appearance,
  systemPrefersDark: boolean,
): ResolvedTheme => {
  if (appearance === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }

  return appearance;
};
