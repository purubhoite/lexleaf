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
  back: 'M6.5 4 2.5 8l4 4M3 8h7a3.5 3.5 0 0 1 0 7H8',
  sidebar: 'M2 3h12v10H2ZM6 3v10',
  view: 'M2.5 2.5h4.5v11H2.5ZM9 2.5h4.5v11H9Z',
  speaker: 'M2.5 6v4h2.5l3.5 3V3L5 6ZM11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9',
  copy: 'M5.5 5.5h8v8h-8ZM10.5 5.5v-3h-8v8h3',
  trash: 'M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9M7 7v4M9 7v4',
  print: 'M4.5 6V2.5h7V6M4.5 11.5h-2V6h11v5.5h-2M4.5 9.5h7v4h-7Z',
  'rotate-right': 'M13 3v3.5H9.5M12.6 6.5A5 5 0 1 0 13 9.5',
  'rotate-left': 'M3 3v3.5h3.5M3.4 6.5A5 5 0 1 1 3 9.5',
  note: 'M3 2.5h10v8l-3 3H3ZM10 13.5v-3h3M5.5 6h5M5.5 8.5h3',
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
