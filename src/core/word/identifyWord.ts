import { normalizeWord } from './normalizeWord';
import type { IdentifiedWord, SegmentLocation, TextSegment } from './types';
import { findWordAt, isHyphen, type WordSpan } from './wordBoundary';

const LINE_BREAK = '\n';

export interface JoinedPageText {
  readonly text: string;
  /** `segmentStarts[i]` is the index in `text` where segment `i` begins. */
  readonly segmentStarts: readonly number[];
}

/**
 * Concatenates text-layer runs into one searchable string.
 *
 * Runs inside a visual line are concatenated without a separator, because the
 * PDF text layer already emits explicit space runs where the document has
 * spaces. A line break is inserted after runs marked `endsLine`, which stops
 * the last word of one line from merging with the first word of the next.
 */
export const joinSegments = (segments: readonly TextSegment[]): JoinedPageText => {
  const segmentStarts: number[] = [];
  let text = '';

  for (const segment of segments) {
    segmentStarts.push(text.length);
    text += segment.text;
    if (segment.endsLine) {
      text += LINE_BREAK;
    }
  }

  return { text, segmentStarts };
};

/** Maps a location inside a run onto an index in the joined page text. */
export const resolveJoinedIndex = (
  segments: readonly TextSegment[],
  joined: JoinedPageText,
  location: SegmentLocation,
): number | null => {
  const segment = segments[location.segmentIndex];
  const segmentStart = joined.segmentStarts[location.segmentIndex];

  if (segment === undefined || segmentStart === undefined) {
    return null;
  }

  const offset = Math.min(Math.max(location.charOffset, 0), segment.text.length);
  return segmentStart + offset;
};

/**
 * Maps an index in the joined page text back onto a text-layer location.
 *
 * The inverse of {@link resolveJoinedIndex}. The pointer path never needs it
 * — a pointer lands on a segment already — but every other way of naming a
 * position does: keyboard navigation, a search match, and the tests that aim
 * at a known word. Keeping one implementation here is what stops those
 * callers inventing their own mapping.
 */
export const locateJoinedIndex = (
  segments: readonly TextSegment[],
  index: number,
): SegmentLocation | null => {
  const { segmentStarts } = joinSegments(segments);

  for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const start = segmentStarts[segmentIndex];
    const segment = segments[segmentIndex];

    if (
      start !== undefined &&
      segment !== undefined &&
      index >= start &&
      index <= start + segment.text.length
    ) {
      return { segmentIndex, charOffset: index - start };
    }
  }

  return null;
};

/** Index of the next non-space character, or null if the line break is followed by nothing usable. */
const skipSpaces = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
    index += 1;
  }
  return index;
};

/** Extends a span to the right so that it includes the trailing hyphen. */
const withHyphen = (text: string, span: WordSpan): WordSpan => ({
  text: text.slice(span.start, span.end + 1),
  start: span.start,
  end: span.end + 1,
});

/**
 * Is this word followed by a hyphen that sits at the very end of its line?
 *
 * A hyphen only becomes part of a word span when word characters surround it,
 * so a hyphen before a line break is always just outside the span.
 */
const hasLineBreakHyphen = (text: string, span: WordSpan): boolean =>
  isHyphen(text[span.end]) && text[span.end + 1] === LINE_BREAK;

/**
 * A word broken across a line break ("recon-" / "sidered") is reassembled.
 *
 * PDFs rarely mark such breaks explicitly, so the rule is positional: a word
 * followed by a hyphen at the end of its line is joined with the first word of
 * the next line. The compound-word ambiguity this cannot resolve is recorded
 * in docs/PDF_SPIKE_REPORT.md.
 *
 * @returns the two halves, first half including the hyphen, or null
 */
const joinForward = (text: string, span: WordSpan): readonly [WordSpan, WordSpan] | null => {
  if (!hasLineBreakHyphen(text, span)) {
    return null;
  }

  const continuation = findWordAt(text, skipSpaces(text, span.end + 2));
  return continuation === null ? null : [withHyphen(text, span), continuation];
};

const joinBackward = (text: string, span: WordSpan): readonly [WordSpan, WordSpan] | null => {
  // Walk back over any leading spaces of this line, then the line break.
  let index = span.start;
  while (index > 0 && (text[index - 1] === ' ' || text[index - 1] === '\t')) {
    index -= 1;
  }
  if (text[index - 1] !== LINE_BREAK || !isHyphen(text[index - 2])) {
    return null;
  }

  const previous = findWordAt(text, index - 3);
  if (previous === null || previous.end !== index - 2) {
    return null;
  }

  return [withHyphen(text, previous), span];
};

const buildWord = (text: string, first: WordSpan, second: WordSpan | null): IdentifiedWord => {
  if (second === null) {
    return {
      raw: first.text,
      display: first.text,
      normalized: normalizeWord(first.text),
      joinedAcrossLines: false,
      start: first.start,
      end: first.end,
    };
  }

  const withoutHyphen = first.text.slice(0, -1);
  return {
    raw: text.slice(first.start, second.end),
    display: `${first.text}${second.text}`,
    normalized: normalizeWord(`${withoutHyphen}${second.text}`),
    joinedAcrossLines: true,
    start: first.start,
    end: second.end,
  };
};

/**
 * Identifies the word at a pointer location inside the text layer.
 *
 * Returns `null` when the location is not over a word; the caller must then
 * show a neutral state rather than guess.
 */
export const identifyWordAt = (
  segments: readonly TextSegment[],
  location: SegmentLocation,
): IdentifiedWord | null => {
  const joined = joinSegments(segments);
  const index = resolveJoinedIndex(segments, joined, location);

  if (index === null) {
    return null;
  }

  const span = findWordAt(joined.text, index);
  if (span === null) {
    return null;
  }

  const joinedHalves = joinForward(joined.text, span) ?? joinBackward(joined.text, span);
  if (joinedHalves !== null) {
    return buildWord(joined.text, joinedHalves[0], joinedHalves[1]);
  }

  const word = buildWord(joined.text, span, null);
  return word.normalized === '' ? null : word;
};
