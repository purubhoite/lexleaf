/**
 * Which pages to look at to decide whether a document has any text.
 *
 * Reading the text of every page of a long book just to say "this is a
 * scan" would be slow, and is not needed: a scan has no text anywhere, so
 * a handful of pages spread through the document settles it. The first
 * and last pages are always among them, and the rest are spaced evenly,
 * so a scanned cover on a real book — or one typed page in front of a
 * scan — does not decide the answer alone.
 */
export const TEXT_PRESENCE_SAMPLE_SIZE = 6;

export const textPresenceSamplePages = (
  pageCount: number,
  sampleSize: number = TEXT_PRESENCE_SAMPLE_SIZE,
): number[] => {
  if (!Number.isInteger(pageCount) || pageCount < 1 || sampleSize < 1) {
    return [];
  }

  if (pageCount <= sampleSize) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  if (sampleSize === 1) {
    return [1];
  }

  const pages = new Set<number>();

  for (let index = 0; index < sampleSize; index += 1) {
    pages.add(1 + Math.round((index * (pageCount - 1)) / (sampleSize - 1)));
  }

  return [...pages].sort((a, b) => a - b);
};

/** `text` as soon as any page has some; `none` only when every one was read and had none. */
export type DocumentTextPresence = 'unknown' | 'text' | 'none';
