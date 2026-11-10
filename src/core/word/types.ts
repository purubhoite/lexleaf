/**
 * A run of text as produced by the PDF text layer.
 *
 * One segment corresponds to one positioned text run. `endsLine` marks the
 * runs after which the renderer starts a new visual line; it is what keeps the
 * last word of a line from being glued to the first word of the next.
 */
export interface TextSegment {
  readonly text: string;
  readonly endsLine: boolean;
}

/** Where the user interacted, expressed in text-layer coordinates. */
export interface SegmentLocation {
  readonly segmentIndex: number;
  readonly charOffset: number;
}

/**
 * The outcome of a successful word identification.
 *
 * The product specification (section 12) requires the raw text, the display
 * form and the lookup form to stay distinct concepts; they are separate fields
 * here and nothing collapses them.
 */
export interface IdentifiedWord {
  /** Exactly the characters found in the page text, line break included. */
  readonly raw: string;
  /** What should be shown to the reader (line break rendered as a hyphen). */
  readonly display: string;
  /** The lookup form: trimmed, case-folded, ligatures expanded. */
  readonly normalized: string;
  /** True when the word was reassembled across a hyphenated line break. */
  readonly joinedAcrossLines: boolean;
  /** Character range within the joined page text. */
  readonly start: number;
  readonly end: number;
}
