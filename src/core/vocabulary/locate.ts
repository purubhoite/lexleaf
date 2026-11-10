import { normalizeWord } from '../word/normalizeWord';

/**
 * Finding a saved word again on the page it was saved from.
 *
 * A saved anchor is a pair of character offsets into the text of a page as
 * it was extracted on the day the word was saved. That text can change: a
 * different build of PDF.js joins runs differently, a repaired file has
 * different content, a page may not even have a text layer any more. So
 * the anchor is treated as a hint to be verified, never as a fact:
 *
 * 1. if the saved range still holds the saved word, it is the answer;
 * 2. otherwise the first occurrence of the same normalised word on that
 *    page is offered, and the caller is told it is approximate;
 * 3. otherwise the honest answer is that the word is not on this page any
 *    more — which is better than highlighting the wrong characters.
 */

export type LocatedWord =
  | { readonly kind: 'exact'; readonly start: number; readonly end: number }
  | { readonly kind: 'approximate'; readonly start: number; readonly end: number }
  | { readonly kind: 'not-found' };

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}'’-]/u.test(character);

/** Every whole-word occurrence of the normalised word, in page order. */
const matchesIn = (text: string, normalized: string): readonly [number, number][] => {
  const found: [number, number][] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (isWordCharacter(text[index]) && !isWordCharacter(text[index - 1])) {
      let end = index;

      while (isWordCharacter(text[end])) {
        end += 1;
      }

      if (normalizeWord(text.slice(index, end)) === normalized) {
        found.push([index, end]);
      }

      index = end;
    }
  }

  return found;
};

export const locateSavedWord = (
  pageText: string,
  normalized: string,
  charStart: number | null,
  charEnd: number | null,
): LocatedWord => {
  if (normalized.length === 0 || pageText.length === 0) {
    return { kind: 'not-found' };
  }

  if (
    charStart !== null &&
    charEnd !== null &&
    charStart >= 0 &&
    charEnd > charStart &&
    charEnd <= pageText.length &&
    normalizeWord(pageText.slice(charStart, charEnd)) === normalized
  ) {
    return { kind: 'exact', start: charStart, end: charEnd };
  }

  const [first] = matchesIn(pageText, normalized);

  return first === undefined
    ? { kind: 'not-found' }
    : { kind: 'approximate', start: first[0], end: first[1] };
};
