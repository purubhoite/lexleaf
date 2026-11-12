import type { ReactElement } from 'react';

/**
 * The application's icons.
 *
 * Drawn here, as vector shapes, rather than typed as characters: a glyph
 * such as ◀ or ✕ is whatever the system's fonts make of it, and came out
 * at a different size, weight and baseline on every machine. These are
 * the same everywhere, take the colour of the text around them, and scale
 * with it.
 *
 * An icon is decoration. It is hidden from assistive technology, and the
 * button it sits in carries the name.
 */

const PATHS = {
  'chevron-left': 'M10 3 5 8l5 5',
  'chevron-right': 'm6 3 5 5-5 5',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  close: 'm4 4 8 8M12 4l-8 8',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.4L14 14',
  contents: 'M2.5 4h1M6 4h7.5M2.5 8h1M6 8h7.5M2.5 12h1M6 12h7.5',
  bookmark: 'M4 2.5h8v11L8 10.5l-4 3Z',
  settings: 'M2.5 5h4m3 0h4M2.5 11h2m3 0h6M8 3.5v3M6 9.5v3',
  expand: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  open: 'M2 12.5v-9h4l1.5 2H14v7Z',
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name }: { readonly name: IconName }): ReactElement => (
  <svg
    className="icon"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={PATHS[name]} />
  </svg>
);
