/**
 * Converts the raw characters of a word into the form used for lookup.
 *
 * The raw text is never modified in place: the caller keeps both, because the
 * reader must still see what the page actually says (specification § 12).
 */

const LEADING_NON_WORD = /^[^\p{L}\p{N}]+/u;
const TRAILING_NON_WORD = /[^\p{L}\p{N}]+$/u;
const TYPOGRAPHIC_APOSTROPHE = /[\u2019\u02BC\u2018]/gu;
const SOFT_HYPHEN = /\u00AD/gu;

/**
 * @param raw characters exactly as they appear in the document
 * @returns the lookup form, or an empty string when nothing lexical remains
 */
export const normalizeWord = (raw: string): string => {
  const unified = raw
    .normalize('NFC')
    .replace(SOFT_HYPHEN, '')
    .replace(TYPOGRAPHIC_APOSTROPHE, "'")
    .replace(/\s+/gu, '');

  const trimmed = unified.replace(LEADING_NON_WORD, '').replace(TRAILING_NON_WORD, '');

  // NFKC folds typographic ligatures (ﬁ → fi) that some PDFs encode directly,
  // so the lookup form matches an ordinary dictionary headword.
  return trimmed.toLowerCase().normalize('NFKC');
};
