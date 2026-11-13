/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettledValue } from './useSettledValue';

describe('a value that waits for the zoom to stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the value it is given', () => {
    const { result } = renderHook(() => useSettledValue(1, 140));

    expect(result.current).toBe(1);
  });

  it('keeps the old value while the new one is still changing, then follows it', () => {
    const { result, rerender } = renderHook(({ value }) => useSettledValue(value, 140), {
      initialProps: { value: 1 },
    });

    rerender({ value: 1.01 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ value: 1.02 });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // 200 ms have passed, but never 140 of them without a change.
    expect(result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(140);
    });

    expect(result.current).toBe(1.02);
  });
});
