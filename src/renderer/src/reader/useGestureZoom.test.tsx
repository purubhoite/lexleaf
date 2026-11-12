// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGestureZoom } from './useGestureZoom';

/*
 * Pinch and Ctrl + wheel, as the scrolling region receives them.
 */

const wheel = (element: HTMLElement, init: WheelEventInit): WheelEvent => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });

  element.dispatchEvent(event);

  return event;
};

describe('zooming by gesture on the document', () => {
  let element: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement('div');
    document.body.append(element);
  });

  afterEach(() => {
    vi.useRealTimers();
    element.remove();
  });

  const mount = (scale = 1, enabled = true): ReturnType<typeof vi.fn<(scale: number) => void>> => {
    const onZoom = vi.fn<(scale: number) => void>();

    renderHook(() => {
      useGestureZoom({ current: element }, scale, onZoom, enabled);
    });

    return onZoom;
  };

  it('zooms on a pinch and keeps the window from zooming itself', () => {
    const onZoom = mount();
    const event = wheel(element, { deltaY: -5, ctrlKey: true });

    vi.runAllTimers();

    expect(event.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom).toHaveBeenLastCalledWith(1.05);
  });

  it('leaves ordinary scrolling completely alone', () => {
    const onZoom = mount();
    const event = wheel(element, { deltaY: 120 });

    vi.runAllTimers();

    expect(event.defaultPrevented).toBe(false);
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('gathers a burst of movements into one change', () => {
    const onZoom = mount();

    for (let index = 0; index < 10; index += 1) {
      wheel(element, { deltaY: -2, ctrlKey: true });
    }

    vi.runAllTimers();

    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom).toHaveBeenLastCalledWith(1.22);
  });

  it('builds each change on the one before it', () => {
    const onZoom = mount();

    wheel(element, { deltaY: -100, ctrlKey: true });
    vi.runAllTimers();
    wheel(element, { deltaY: -100, ctrlKey: true });
    vi.runAllTimers();

    expect(onZoom.mock.calls.map((call) => call[0])).toStrictEqual([1.16, 1.35]);
  });

  it('reports nothing once the limit is reached', () => {
    const onZoom = mount(4);

    wheel(element, { deltaY: -100, ctrlKey: true });
    vi.runAllTimers();

    expect(onZoom).not.toHaveBeenCalled();
  });

  it('does nothing while there is no document', () => {
    const onZoom = mount(1, false);
    const event = wheel(element, { deltaY: -5, ctrlKey: true });

    vi.runAllTimers();

    expect(event.defaultPrevented).toBe(false);
    expect(onZoom).not.toHaveBeenCalled();
  });
});
