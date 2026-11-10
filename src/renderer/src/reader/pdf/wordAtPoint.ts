import { identifyWordAt } from '@core/word/identifyWord';
import type { IdentifiedWord } from '@core/word/types';

import { pickCharacterIndex, type Rect } from './pickCharacterIndex';
import type { TextLayerIndex } from './textLayerIndex';

/**
 * Turns a pointer position into the word the user is pointing at.
 *
 * The lookup is DOM based, as required by the architecture: the browser is
 * asked which element and which character sit under the pointer, and the word
 * rules then run on the text of the layer. Nothing here reasons about PDF
 * coordinates.
 */

interface CaretHit {
  readonly node: Node;
  readonly offset: number;
}

/**
 * `caretPositionFromPoint` is the standard API; `caretRangeFromPoint` is the
 * older WebKit spelling kept as a fallback so the feature degrades instead of
 * disappearing.
 */
const caretAt = (ownerDocument: Document, x: number, y: number): CaretHit | null => {
  const position = ownerDocument.caretPositionFromPoint?.(x, y) ?? null;

  if (position !== null) {
    return { node: position.offsetNode, offset: position.offset };
  }

  const range = ownerDocument.caretRangeFromPoint?.(x, y) ?? null;

  return range === null ? null : { node: range.startContainer, offset: range.startOffset };
};

const characterRect = (node: Text, index: number): Rect | null => {
  const range = node.ownerDocument.createRange();

  range.setStart(node, index);
  range.setEnd(node, index + 1);

  const rect = range.getBoundingClientRect();

  range.detach();

  return rect.width === 0 && rect.height === 0 ? null : rect;
};
export interface PointerTarget {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Why no word was reported.
 *
 * The reasons are distinct states rather than a plain `null`, so that the
 * behaviour can be observed while the spike runs: "there is nothing there"
 * and "the browser would not say where the caret is" are different findings
 * and must not be collapsed into one silent result.
 */
export type HitMiss =
  | 'nothing-at-point'
  | 'outside-text-layer'
  | 'no-caret-position'
  | 'caret-in-another-run'
  | 'pointer-between-characters'
  | 'whitespace'
  | 'not-a-word';

export type HitResult =
  | { readonly kind: 'word'; readonly word: IdentifiedWord; readonly characterIndex: number }
  | { readonly kind: 'miss'; readonly reason: HitMiss };

const miss = (reason: HitMiss): HitResult => ({ kind: 'miss', reason });

/**
 * @param layer   text layer of the page currently on screen
 * @param pointer pointer position in client coordinates
 */
export const hitTestWord = (
  ownerDocument: Document,
  layer: TextLayerIndex,
  pointer: PointerTarget,
): HitResult => {
  const { clientX, clientY } = pointer;
  const element = ownerDocument.elementFromPoint(clientX, clientY);

  if (element === null) {
    return miss('nothing-at-point');
  }

  const segmentIndex = layer.segmentOf.get(element);

  if (segmentIndex === undefined) {
    // The pointer is over the page background, a margin, or an image.
    return miss('outside-text-layer');
  }

  const caret = caretAt(ownerDocument, clientX, clientY);

  if (caret === null) {
    return miss('no-caret-position');
  }

  if (caret.node.nodeType !== Node.TEXT_NODE || caret.node.parentElement !== element) {
    return miss('caret-in-another-run');
  }

  const textNode = caret.node as Text;
  const characterIndex = pickCharacterIndex({
    caretOffset: caret.offset,
    length: textNode.length,
    pointerX: clientX,
    pointerY: clientY,
    rectAt: (index) => characterRect(textNode, index),
  });

  if (characterIndex === null) {
    return miss('pointer-between-characters');
  }

  // Pointing at the gap between two words is not pointing at a word; showing
  // the nearest one would be guessing.
  if (/\s/u.test(textNode.data[characterIndex] ?? '')) {
    return miss('whitespace');
  }

  const word = identifyWordAt(layer.segments, { segmentIndex, charOffset: characterIndex });

  return word === null ? miss('not-a-word') : { kind: 'word', word, characterIndex };
};
