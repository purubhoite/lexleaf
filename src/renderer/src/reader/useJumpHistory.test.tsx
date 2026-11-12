/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useJumpHistory } from './useJumpHistory';

describe('going back after a jump', () => {
  it('has nowhere to go back to at first', () => {
    const { result } = renderHook(() => useJumpHistory('a'));

    expect(result.current.canGoBack).toBe(false);
    expect(result.current.back()).toBeNull();
  });

  it('returns to the places left, most recent first', () => {
    const { result } = renderHook(() => useJumpHistory('a'));

    act(() => {
      result.current.remember({ page: 3, pageOffsetFraction: 0.5 });
    });
    act(() => {
      result.current.remember({ page: 40, pageOffsetFraction: 0 });
    });

    let place: unknown = null;

    act(() => {
      place = result.current.back();
    });
    expect(place).toStrictEqual({ page: 40, pageOffsetFraction: 0 });

    act(() => {
      place = result.current.back();
    });
    expect(place).toStrictEqual({ page: 3, pageOffsetFraction: 0.5 });
    expect(result.current.canGoBack).toBe(false);
  });

  it('counts two jumps from one place as one step back', () => {
    const { result } = renderHook(() => useJumpHistory('a'));

    act(() => {
      result.current.remember({ page: 3, pageOffsetFraction: 0.5 });
    });
    act(() => {
      result.current.remember({ page: 3, pageOffsetFraction: 0.505 });
    });
    act(() => {
      result.current.back();
    });

    expect(result.current.canGoBack).toBe(false);
  });

  it('starts again for another book', () => {
    const { result, rerender } = renderHook(({ id }) => useJumpHistory(id), {
      initialProps: { id: 'a' },
    });

    act(() => {
      result.current.remember({ page: 3, pageOffsetFraction: 0.5 });
    });
    rerender({ id: 'b' });

    expect(result.current.canGoBack).toBe(false);
    expect(result.current.back()).toBeNull();
  });
});
