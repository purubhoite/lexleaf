import { identifyWordAt, joinSegments, locateJoinedIndex } from '@core/word/identifyWord';

import { hitTestWord, type HitResult, type PointerTarget } from '../pdf/wordAtPoint';

import type { LivePage, PageRegistry } from './pageRegistry';

/**
 * Every route from "the reader indicated something" to "this is the word".
 *
 * There are three routes — pointer, selection and keyboard — and they all
 * end in the same two core calls (`identifyWordAt`, or the hit test that
 * feeds it). None of them re-implements word boundaries or normalisation;
 * each one only works out a *text position* and hands it over (ADR-018).
 *
 * The result always carries the identity of the page it came from, so the
 * caller can tell a live answer from one produced by a page that has since
 * been recycled.
 */

export type InteractionSource = 'pointer' | 'selection' | 'keyboard';

export interface WordInteraction {
  readonly source: InteractionSource;
  readonly documentId: string;
  readonly pageNumber: number;
  /** Render generation of the layer that produced it. */
  readonly generation: number;
  readonly hit: HitResult;
  /** Index in the joined page text, when the route knows one. */
  readonly textIndex: number | null;
  readonly milliseconds: number;
}

const elapsedSince = (started: number): number =>
  Math.round((performance.now() - started) * 100) / 100;

/** The word under a pointer, resolved against whichever page owns that pixel. */
export const resolvePointerInteraction = (
  ownerDocument: Document,
  registry: PageRegistry,
  pointer: PointerTarget,
): WordInteraction | null => {
  const started = performance.now();
  const element = ownerDocument.elementFromPoint(pointer.clientX, pointer.clientY);
  const page = registry.pageOfNode(element);

  if (page === null) {
    return null;
  }

  const hit = hitTestWord(ownerDocument, page.layer, pointer);

  return {
    source: 'pointer',
    documentId: page.documentId,
    pageNumber: page.pageNumber,
    generation: page.generation,
    hit,
    textIndex: null,
    milliseconds: elapsedSince(started),
  };
};

/** The outcome of pointing at a page but not at any of its text. */
export const neutralInteraction = (page: LivePage, source: InteractionSource): WordInteraction => ({
  source,
  documentId: page.documentId,
  pageNumber: page.pageNumber,
  generation: page.generation,
  hit: { kind: 'miss', reason: 'not-a-word' },
  textIndex: null,
  milliseconds: 0,
});

/**
 * The word at a known index in a page's text.
 *
 * Used by the keyboard route, and by anything else that already knows where
 * it is in the text rather than where it is on screen.
 */
export const resolveTextIndexInteraction = (
  page: LivePage,
  textIndex: number,
  source: InteractionSource,
): WordInteraction => {
  const started = performance.now();
  const location = locateJoinedIndex(page.layer.segments, textIndex);
  const word = location === null ? null : identifyWordAt(page.layer.segments, location);

  return {
    source,
    documentId: page.documentId,
    pageNumber: page.pageNumber,
    generation: page.generation,
    hit:
      word === null
        ? { kind: 'miss', reason: 'not-a-word' }
        : { kind: 'word', word, characterIndex: location?.charOffset ?? 0 },
    textIndex,
    milliseconds: elapsedSince(started),
  };
};

/** Minimal view of a DOM selection, so the rule is testable without one. */
export interface SelectionPoint {
  readonly node: Node | null;
  readonly offset: number;
  readonly isCollapsed: boolean;
}

/**
 * The word a text selection starts in.
 *
 * Selection is routed through the same identification as everything else
 * rather than through `selection.toString()`: the string a browser reports
 * for a PDF text layer contains the layer's own line breaks and run
 * boundaries, and trusting it would mean a second, worse set of word rules.
 */
export const resolveSelectionInteraction = (
  point: SelectionPoint,
  registry: PageRegistry,
): WordInteraction | null => {
  const started = performance.now();
  const page = registry.pageOfNode(point.node);

  if (page === null || point.node === null) {
    return null;
  }

  const element = point.node.nodeType === Node.TEXT_NODE ? point.node.parentElement : null;
  const segmentIndex = element === null ? undefined : page.layer.segmentOf.get(element);

  if (segmentIndex === undefined) {
    return null;
  }

  const { segmentStarts } = joinSegments(page.layer.segments);
  const segmentStart = segmentStarts[segmentIndex];

  if (segmentStart === undefined) {
    return null;
  }

  const word = identifyWordAt(page.layer.segments, { segmentIndex, charOffset: point.offset });

  return {
    source: 'selection',
    documentId: page.documentId,
    pageNumber: page.pageNumber,
    generation: page.generation,
    hit:
      word === null
        ? { kind: 'miss', reason: 'not-a-word' }
        : { kind: 'word', word, characterIndex: point.offset },
    textIndex: segmentStart + point.offset,
    milliseconds: elapsedSince(started),
  };
};

/**
 * True when an interaction describes a page that is no longer on screen as
 * it was.
 *
 * This is the guard that makes a recycled page harmless: the panel shows
 * nothing rather than a word from a layer that has been thrown away.
 */
export const isStaleInteraction = (
  interaction: WordInteraction,
  registry: PageRegistry,
  documentId: string | null,
): boolean => {
  if (documentId !== null && interaction.documentId !== documentId) {
    return true;
  }

  const page = registry.get(interaction.pageNumber);

  return page === null || page.generation !== interaction.generation;
};

export const wordOf = (interaction: WordInteraction | null): HitResult | null =>
  interaction === null ? null : interaction.hit;
