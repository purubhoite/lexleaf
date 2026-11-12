/** @vitest-environment jsdom */
import { DEFAULT_PREFERENCES, type Preferences } from '@core/persistence/preferences';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_READER_STATE_SNAPSHOT,
  type DesktopBridge,
  type ReaderStateSnapshot,
} from '@shared/ipc/contracts';

import { usePreferences } from './usePreferences';

/**
 * The renderer's copy of the four preferences (ADR-031).
 *
 * What these tests hold down is the integration, not the storage: that a
 * change reaches `data-theme` and `data-motion` — the attributes 6.6 and
 * 6.7 already own — and reaches the main process exactly once, and that
 * neither a missing bridge nor a failing write breaks anything.
 */

const bridgeWith = (
  snapshot: Partial<ReaderStateSnapshot> = {},
  savePreferences = vi.fn<(preferences: Preferences) => Promise<void>>(() => Promise.resolve()),
): { bridge: DesktopBridge; savePreferences: typeof savePreferences } => ({
  savePreferences,
  bridge: {
    getReaderState: () => Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, ...snapshot }),
    savePreferences,
  } as unknown as DesktopBridge,
});

const stored = (preferences: Partial<Preferences>): Partial<ReaderStateSnapshot> => ({
  preferences: { ...DEFAULT_PREFERENCES, ...preferences },
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
});

describe('reading the stored preferences', () => {
  it('starts at the defaults before the main process answers', () => {
    const { bridge } = bridgeWith();
    const { result } = renderHook(() => usePreferences(bridge));

    expect(result.current.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('adopts what was stored and writes both attributes', async () => {
    const { bridge } = bridgeWith(stored({ appearance: 'dark', reduceMotion: 'always' }));
    const { result } = renderHook(() => usePreferences(bridge));

    await waitFor(() => {
      expect(result.current.preferences.appearance).toBe('dark');
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
  });

  it('leaves the system to answer when the appearance follows it', async () => {
    const { bridge } = bridgeWith(stored({ appearance: 'system', reduceMotion: 'system' }));
    const { result } = renderHook(() => usePreferences(bridge));

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('system');
    });

    expect(document.documentElement.getAttribute('data-motion')).toBe('system');
    expect(result.current.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('keeps the defaults when the state cannot be read', async () => {
    const bridge = {
      getReaderState: () => Promise.reject(new Error('no state')),
      savePreferences: vi.fn(() => Promise.resolve()),
    } as unknown as DesktopBridge;

    const { result } = renderHook(() => usePreferences(bridge));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('works with no bridge at all', () => {
    const { result } = renderHook(() => usePreferences(null));

    expect(result.current.preferences).toStrictEqual(DEFAULT_PREFERENCES);
    expect(() => {
      act(() => {
        result.current.set('appearance', 'dark');
      });
    }).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('changing a preference', () => {
  it('applies the appearance to the document and stores all four fields', async () => {
    const { bridge, savePreferences } = bridgeWith();
    const { result } = renderHook(() => usePreferences(bridge));

    act(() => {
      result.current.set('appearance', 'light');
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(result.current.preferences.appearance).toBe('light');

    await waitFor(() => {
      expect(savePreferences).toHaveBeenCalledWith({
        ...DEFAULT_PREFERENCES,
        appearance: 'light',
      });
    });
  });

  it('applies reduced motion through the existing resolver', () => {
    const { bridge } = bridgeWith();
    const { result } = renderHook(() => usePreferences(bridge));

    act(() => {
      result.current.set('reduceMotion', 'always');
    });

    // `always` resolves to `reduced`; `system` stays `system` so the media
    // query in global.css keeps the decision (ADR-032).
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');

    act(() => {
      result.current.set('reduceMotion', 'system');
    });

    expect(document.documentElement.getAttribute('data-motion')).toBe('system');
  });

  it('sends one message per change, and only the preference fields', () => {
    const { bridge, savePreferences } = bridgeWith();
    const { result } = renderHook(() => usePreferences(bridge));

    act(() => {
      result.current.set('appearance', 'dark');
    });
    act(() => {
      result.current.set('defaultZoomMode', 'fit-page');
    });

    expect(savePreferences).toHaveBeenCalledTimes(2);
    expect(savePreferences.mock.calls.map((call) => Object.keys(call[0]))).toStrictEqual([
      ['appearance', 'reduceMotion', 'defaultZoomMode', 'showDeveloperDiagnostics', 'pageTint'],
      ['appearance', 'reduceMotion', 'defaultZoomMode', 'showDeveloperDiagnostics', 'pageTint'],
    ]);
  });

  it('accumulates changes rather than resetting the others', () => {
    const { bridge, savePreferences } = bridgeWith();
    const { result } = renderHook(() => usePreferences(bridge));

    act(() => {
      result.current.set('appearance', 'dark');
    });
    act(() => {
      result.current.set('showDeveloperDiagnostics', 'on');
    });

    expect(result.current.preferences).toStrictEqual({
      ...DEFAULT_PREFERENCES,
      appearance: 'dark',
      showDeveloperDiagnostics: 'on',
      pageTint: 'original',
    });
    expect(savePreferences).toHaveBeenLastCalledWith({
      ...DEFAULT_PREFERENCES,
      appearance: 'dark',
      showDeveloperDiagnostics: 'on',
      pageTint: 'original',
    });
  });

  it('keeps the change on screen when the write fails', async () => {
    const savePreferences = vi.fn<(preferences: Preferences) => Promise<void>>(() =>
      Promise.reject(new Error('disk full')),
    );
    const { bridge } = bridgeWith({}, savePreferences);
    const { result } = renderHook(() => usePreferences(bridge));

    act(() => {
      result.current.set('appearance', 'dark');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.preferences.appearance).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('never calls matchMedia', () => {
    // ADR-030 and ADR-032 both rest on the cascade answering the system
    // question. A renderer that asks it a second way can disagree with
    // its own stylesheet.
    const matchMedia = vi.fn();

    Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true });

    const { bridge } = bridgeWith();
    const { result } = renderHook(() => usePreferences(bridge));

    act(() => {
      result.current.set('appearance', 'system');
      result.current.set('reduceMotion', 'system');
    });

    expect(matchMedia).not.toHaveBeenCalled();
  });
});
