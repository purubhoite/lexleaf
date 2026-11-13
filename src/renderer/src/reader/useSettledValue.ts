import { useEffect, useState } from 'react';

/**
 * A value that follows another only once it has stopped changing.
 *
 * The page uses it for its zoom: while the reader is zooming, the picture
 * already on the page is stretched, which costs nothing; the page is drawn
 * again, sharply, only when the zoom has been still for `delay`
 * milliseconds. Drawing for every step is what made zooming flicker.
 */
export const useSettledValue = <Value>(value: Value, delay: number): Value => {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (Object.is(settled, value)) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delay);

    return (): void => {
      window.clearTimeout(timer);
    };
  }, [value, settled, delay]);

  return settled;
};
