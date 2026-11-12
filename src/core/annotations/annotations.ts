/**
 * What a reader adds to a book: highlights, the notes on them, bookmarks,
 * and which way up they turned the pages.
 *
 * None of it touches the PDF. It is kept beside the saved words, on this
 * computer, keyed by the document's identity, and is laid over the page
 * when the book is open.
 *
 * Everything here is pure. `parseDocumentAnnotations` is the one door a
 * value from disk or from the window comes through: whatever it is given,
 * it returns a well-formed set, dropping what it cannot make sense of.
 */

export const HIGHLIGHT_COLOURS = ['yellow', 'green', 'blue', 'pink'] as const;

export type HighlightColour = (typeof HIGHLIGHT_COLOURS)[number];

export const PAGE_ROTATIONS = [0, 90, 180, 270] as const;

export type PageRotation = (typeof PAGE_ROTATIONS)[number];

export interface Highlight {
  readonly id: string;
  /** 1-based page number. */
  readonly page: number;
  /** Offsets into the page's text, as the text layer joins it. */
  readonly start: number;
  readonly end: number;
  /** The highlighted words, kept so the list can show them without the page. */
  readonly text: string;
  readonly colour: HighlightColour;
  /** The reader's note; empty when there is none. */
  readonly note: string;
  readonly createdAt: string;
}

export interface Bookmark {
  readonly page: number;
  readonly label: string;
  readonly createdAt: string;
}

export interface DocumentAnnotations {
  readonly highlights: readonly Highlight[];
  readonly bookmarks: readonly Bookmark[];
  readonly rotation: PageRotation;
}

export const EMPTY_ANNOTATIONS: DocumentAnnotations = {
  highlights: [],
  bookmarks: [],
  rotation: 0,
};

export const MAX_HIGHLIGHTS = 5000;
export const MAX_BOOKMARKS = 1000;
export const MAX_HIGHLIGHT_TEXT = 2000;
export const MAX_NOTE_LENGTH = 4000;
export const MAX_LABEL_LENGTH = 200;
const MAX_ID_LENGTH = 80;
const MAX_PAGE = 1_000_000;
const MAX_OFFSET = 10_000_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, limit: number): string | null =>
  typeof value === 'string' ? value.slice(0, limit) : null;

const wholeNumber = (value: unknown, low: number, high: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
    ? value
    : null;

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))
    ? value
    : null;

const parseHighlight = (value: unknown): Highlight | null => {
  if (!isObject(value)) {
    return null;
  }

  const id = boundedString(value['id'], MAX_ID_LENGTH);
  const page = wholeNumber(value['page'], 1, MAX_PAGE);
  const start = wholeNumber(value['start'], 0, MAX_OFFSET);
  const end = wholeNumber(value['end'], 0, MAX_OFFSET);
  const text = boundedString(value['text'], MAX_HIGHLIGHT_TEXT);
  const colour = HIGHLIGHT_COLOURS.find((candidate) => candidate === value['colour']);
  const createdAt = isoDate(value['createdAt']);

  if (
    id === null ||
    id.length === 0 ||
    page === null ||
    start === null ||
    end === null ||
    end <= start ||
    text === null ||
    colour === undefined ||
    createdAt === null
  ) {
    return null;
  }

  return {
    id,
    page,
    start,
    end,
    text,
    colour,
    note: boundedString(value['note'], MAX_NOTE_LENGTH) ?? '',
    createdAt,
  };
};

const parseBookmark = (value: unknown): Bookmark | null => {
  if (!isObject(value)) {
    return null;
  }

  const page = wholeNumber(value['page'], 1, MAX_PAGE);
  const createdAt = isoDate(value['createdAt']);

  if (page === null || createdAt === null) {
    return null;
  }

  return { page, label: boundedString(value['label'], MAX_LABEL_LENGTH) ?? '', createdAt };
};

const inReadingOrder = (left: Highlight, right: Highlight): number =>
  left.page - right.page || left.start - right.start || left.end - right.end;

export const parseDocumentAnnotations = (value: unknown): DocumentAnnotations => {
  if (!isObject(value)) {
    return EMPTY_ANNOTATIONS;
  }

  const rawHighlights = Array.isArray(value['highlights']) ? value['highlights'] : [];
  const rawBookmarks = Array.isArray(value['bookmarks']) ? value['bookmarks'] : [];

  const seenIds = new Set<string>();
  const highlights: Highlight[] = [];

  for (const raw of rawHighlights.slice(0, MAX_HIGHLIGHTS)) {
    const highlight = parseHighlight(raw);

    if (highlight !== null && !seenIds.has(highlight.id)) {
      seenIds.add(highlight.id);
      highlights.push(highlight);
    }
  }

  const seenPages = new Set<number>();
  const bookmarks: Bookmark[] = [];

  for (const raw of rawBookmarks.slice(0, MAX_BOOKMARKS)) {
    const bookmark = parseBookmark(raw);

    // One bookmark a page: a page is either marked or it is not.
    if (bookmark !== null && !seenPages.has(bookmark.page)) {
      seenPages.add(bookmark.page);
      bookmarks.push(bookmark);
    }
  }

  return {
    highlights: highlights.sort(inReadingOrder),
    bookmarks: bookmarks.sort((left, right) => left.page - right.page),
    rotation: PAGE_ROTATIONS.find((candidate) => candidate === value['rotation']) ?? 0,
  };
};

export const isEmptyAnnotations = (annotations: DocumentAnnotations): boolean =>
  annotations.highlights.length === 0 &&
  annotations.bookmarks.length === 0 &&
  annotations.rotation === 0;

/* ------------------------------------------------------------------ *
 * Changes. Each returns a new set and leaves the old one alone.
 * ------------------------------------------------------------------ */

export interface NewHighlight {
  readonly id: string;
  readonly page: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly colour: HighlightColour;
  readonly at: string;
}

const overlaps = (highlight: Highlight, page: number, start: number, end: number): boolean =>
  highlight.page === page && highlight.start < end && start < highlight.end;

/**
 * Adds a highlight. One that overlaps existing highlights takes them in:
 * the result is a single highlight over everything they covered between
 * them, in the new colour, carrying their notes. Marking a sentence twice
 * therefore never leaves two layers to peel apart.
 */
export const addHighlight = (
  annotations: DocumentAnnotations,
  added: NewHighlight,
): DocumentAnnotations => {
  if (added.end <= added.start || annotations.highlights.length >= MAX_HIGHLIGHTS) {
    return annotations;
  }

  const absorbed = annotations.highlights.filter((highlight) =>
    overlaps(highlight, added.page, added.start, added.end),
  );
  const kept = annotations.highlights.filter((highlight) => !absorbed.includes(highlight));
  const start = Math.min(added.start, ...absorbed.map((highlight) => highlight.start));
  const end = Math.max(added.end, ...absorbed.map((highlight) => highlight.end));
  const notes = absorbed.map((highlight) => highlight.note).filter((note) => note.length > 0);

  // When the new selection lies wholly inside one old highlight, the old
  // text is the fuller one; otherwise the new selection's words are kept.
  const widest = absorbed.find((highlight) => highlight.start === start && highlight.end === end);

  const merged: Highlight = {
    id: added.id,
    page: added.page,
    start,
    end,
    text: (widest?.text ?? added.text).slice(0, MAX_HIGHLIGHT_TEXT),
    colour: added.colour,
    note: notes.join('\n\n').slice(0, MAX_NOTE_LENGTH),
    createdAt: added.at,
  };

  return { ...annotations, highlights: [...kept, merged].sort(inReadingOrder) };
};

export const updateHighlight = (
  annotations: DocumentAnnotations,
  id: string,
  change: { readonly colour?: HighlightColour; readonly note?: string },
): DocumentAnnotations => ({
  ...annotations,
  highlights: annotations.highlights.map((highlight) =>
    highlight.id === id
      ? {
          ...highlight,
          colour: change.colour ?? highlight.colour,
          note: (change.note ?? highlight.note).slice(0, MAX_NOTE_LENGTH),
        }
      : highlight,
  ),
});

export const removeHighlight = (
  annotations: DocumentAnnotations,
  id: string,
): DocumentAnnotations => ({
  ...annotations,
  highlights: annotations.highlights.filter((highlight) => highlight.id !== id),
});

/** The highlight under a place in a page's text, if there is one. */
export const highlightAt = (
  annotations: DocumentAnnotations,
  page: number,
  index: number,
): Highlight | null =>
  annotations.highlights.find(
    (highlight) => highlight.page === page && index >= highlight.start && index < highlight.end,
  ) ?? null;

export const isBookmarked = (annotations: DocumentAnnotations, page: number): boolean =>
  annotations.bookmarks.some((bookmark) => bookmark.page === page);

export const toggleBookmark = (
  annotations: DocumentAnnotations,
  page: number,
  label: string,
  at: string,
): DocumentAnnotations => {
  if (isBookmarked(annotations, page)) {
    return {
      ...annotations,
      bookmarks: annotations.bookmarks.filter((bookmark) => bookmark.page !== page),
    };
  }

  if (annotations.bookmarks.length >= MAX_BOOKMARKS) {
    return annotations;
  }

  return {
    ...annotations,
    bookmarks: [
      ...annotations.bookmarks,
      { page, label: label.slice(0, MAX_LABEL_LENGTH), createdAt: at },
    ].sort((left, right) => left.page - right.page),
  };
};

export const rotateBy = (rotation: PageRotation, quarterTurns: number): PageRotation => {
  const turned = (((rotation + quarterTurns * 90) % 360) + 360) % 360;

  return PAGE_ROTATIONS.find((candidate) => candidate === turned) ?? 0;
};

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * The reader's highlights, notes and bookmarks as a Markdown document: it
 * reads as plain text anywhere, and pastes into any notes application.
 */
export const annotationsToMarkdown = (
  documentName: string,
  annotations: DocumentAnnotations,
): string => {
  const lines: string[] = [`# Notes from ${oneLine(documentName)}`, ''];

  if (annotations.bookmarks.length > 0) {
    lines.push('## Bookmarks', '');

    for (const bookmark of annotations.bookmarks) {
      const label = oneLine(bookmark.label);

      lines.push(`- Page ${String(bookmark.page)}${label.length > 0 ? ` — ${label}` : ''}`);
    }

    lines.push('');
  }

  if (annotations.highlights.length > 0) {
    lines.push('## Highlights', '');

    let page = 0;

    for (const highlight of annotations.highlights) {
      if (highlight.page !== page) {
        page = highlight.page;
        lines.push(`### Page ${String(page)}`, '');
      }

      lines.push(`> ${oneLine(highlight.text)}`, '');

      if (highlight.note.trim().length > 0) {
        lines.push(
          ...highlight.note
            .trim()
            .split(/\r?\n/u)
            .map((line) => line.trimEnd()),
          '',
        );
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
};

/** A file name for the export: the book's name, made safe for any system. */
export const annotationsFileName = (documentName: string): string => {
  const base = documentName
    .replace(/\.pdf$/iu, '')
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);

  return `${base.length > 0 ? base : 'book'} - notes.md`;
};

export type AnnotationsExportOutcome =
  | { readonly status: 'exported'; readonly count: number }
  | { readonly status: 'empty' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed' };
