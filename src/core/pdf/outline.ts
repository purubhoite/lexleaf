/**
 * A document's table of contents, as the reader is shown it.
 *
 * A PDF carries its outline as a tree of titles, each pointing somewhere
 * in the document in one of several ways. None of that reaches the screen:
 * the reader gets a flat, ordered list of entries with a depth and, where
 * the destination could be worked out, a page number.
 *
 * Everything in an outline was written by whoever made the file, so it is
 * bounded here: a hostile or broken document can make the list long, deep
 * or cyclic, and none of those may hang the reader or flood the screen.
 */

export interface PdfOutlineEntry {
  readonly title: string;
  /** 1-based. `null` when the entry points nowhere this reader can go. */
  readonly pageNumber: number | null;
  /** 0 for a top-level entry. */
  readonly depth: number;
}

/** The shape an engine hands over: a title, a destination it understands, children. */
export interface RawOutlineNode {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: unknown;
}

export const OUTLINE_MAXIMUM_ENTRIES = 2_000;
export const OUTLINE_MAXIMUM_DEPTH = 8;
export const OUTLINE_MAXIMUM_TITLE_LENGTH = 200;

/**
 * Titles come out of the file with whatever is in it: line breaks, runs of
 * spaces, control characters, and sometimes nothing at all.
 */
const cleanTitle = (raw: unknown): string => {
  if (typeof raw !== 'string') {
    return '';
  }

  // Control characters and every kind of white space become one space.
  const collapsed = raw.replace(/[\p{Cc}\s]+/gu, ' ').trim();

  return collapsed.length > OUTLINE_MAXIMUM_TITLE_LENGTH
    ? `${collapsed.slice(0, OUTLINE_MAXIMUM_TITLE_LENGTH - 1).trimEnd()}…`
    : collapsed;
};

/**
 * Flattens an outline tree, asking `resolvePage` where each entry points.
 *
 * `resolvePage` answers with a 1-based page number or `null`; an answer
 * outside the document, or a resolver that throws, leaves the entry
 * without a page rather than losing the entry or the whole outline.
 */
export const flattenOutline = async (
  roots: unknown,
  pageCount: number,
  resolvePage: (destination: unknown) => Promise<number | null>,
): Promise<PdfOutlineEntry[]> => {
  const entries: PdfOutlineEntry[] = [];
  const seen = new Set<unknown>();

  const visit = async (nodes: unknown, depth: number): Promise<void> => {
    if (!Array.isArray(nodes) || depth >= OUTLINE_MAXIMUM_DEPTH) {
      return;
    }

    for (const node of nodes as readonly unknown[]) {
      if (entries.length >= OUTLINE_MAXIMUM_ENTRIES) {
        return;
      }

      if (typeof node !== 'object' || node === null || seen.has(node)) {
        continue;
      }

      seen.add(node);

      const { title: rawTitle, dest, items } = node as RawOutlineNode;
      const title = cleanTitle(rawTitle);

      if (title.length > 0) {
        let pageNumber: number | null = null;

        try {
          const resolved = dest === undefined || dest === null ? null : await resolvePage(dest);

          if (
            resolved !== null &&
            Number.isInteger(resolved) &&
            resolved >= 1 &&
            resolved <= pageCount
          ) {
            pageNumber = resolved;
          }
        } catch {
          pageNumber = null;
        }

        entries.push({ title, pageNumber, depth });
      }

      // An untitled entry still lends its children to the list, one level
      // up, so a chapter list under a blank root is not lost.
      await visit(items, title.length > 0 ? depth + 1 : depth);
    }
  };

  await visit(roots, 0);

  return entries;
};

/**
 * The outline entry the reader is currently inside: of the entries that
 * start on or before the page they are on, the one that starts latest, and
 * of several on that page the last (the deepest heading wins over its
 * parent). `-1` when the reader is before every entry.
 */
export const activeOutlineIndex = (
  entries: readonly PdfOutlineEntry[],
  currentPage: number,
): number => {
  let active = -1;
  let activePage = 0;

  entries.forEach((entry, index) => {
    if (
      entry.pageNumber !== null &&
      entry.pageNumber <= currentPage &&
      entry.pageNumber >= activePage
    ) {
      active = index;
      activePage = entry.pageNumber;
    }
  });

  return active;
};
