/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PERSISTENCE_FAILURE_MESSAGE, usePersistenceNotice } from './usePersistenceNotice';

/**
 * The counting rule behind "one notice per session" (M7.2, R6).
 *
 * The visible behaviour is asserted through the real application in
 * `persistence.test.tsx`; this file pins the small state machine that
 * makes it true, because the thing most likely to regress is not the
 * markup — it is the moment a second failed write raises a second notice.
 */

describe('usePersistenceNotice', () => {
  it('says nothing until a write actually fails', () => {
    const { result } = renderHook(() => usePersistenceNotice());

    expect(result.current.visible).toBe(false);

    act(() => {
      result.current.report('ok');
      result.current.report('ok');
    });

    expect(result.current.visible).toBe(false);
  });

  it('raises the notice on the first failing write', () => {
    const { result } = renderHook(() => usePersistenceNotice());

    act(() => {
      result.current.report('failing');
    });

    expect(result.current.visible).toBe(true);
  });

  it('does not raise a second notice, however many writes fail', () => {
    const { result } = renderHook(() => usePersistenceNotice());

    act(() => {
      for (let index = 0; index < 50; index += 1) {
        result.current.report('failing');
      }
    });

    expect(result.current.visible).toBe(true);
  });

  it('stays dismissed once the reader has dismissed it', () => {
    const { result } = renderHook(() => usePersistenceNotice());

    act(() => {
      result.current.report('failing');
    });
    act(() => {
      result.current.dismiss();
    });

    expect(result.current.visible).toBe(false);

    // A reading position is written every few seconds. If dismissal only
    // hid the notice until the next failure, the reader would be told the
    // same thing again immediately — which is the "do not spam" rule, and
    // the reason dismissal is terminal for the session.
    act(() => {
      result.current.report('failing');
      result.current.report('failing');
    });

    expect(result.current.visible).toBe(false);
  });

  it('does not retract the notice when a later write succeeds', () => {
    const { result } = renderHook(() => usePersistenceNotice());

    act(() => {
      result.current.report('failing');
      result.current.report('ok');
    });

    expect(result.current.visible).toBe(true);
  });

  it('keeps a stable identity so a caller may depend on it', () => {
    const { result, rerender } = renderHook(() => usePersistenceNotice());
    const first = result.current.report;

    rerender();

    expect(result.current.report).toBe(first);
  });

  it('tells the reader what is happening without claiming the write worked', () => {
    expect(PERSISTENCE_FAILURE_MESSAGE).toContain('cannot be saved');
    expect(PERSISTENCE_FAILURE_MESSAGE).toContain('Reading is not affected');

    for (const forbidden of ['saved successfully', 'ENOENT', 'EACCES', '/', '\\', 'error']) {
      expect({ forbidden, message: PERSISTENCE_FAILURE_MESSAGE }).toStrictEqual({
        forbidden,
        message: expect.not.stringContaining(forbidden) as string,
      });
    }
  });
});
