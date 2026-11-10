import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPdfjsEngine } from '../../../src/core/pdf/pdfjs/pdfjsEngine';
import type { PdfjsModule } from '../../../src/core/pdf/pdfjs/pdfjsModule';
import type { PdfEngine } from '../../../src/core/pdf/pdfEngine';
import { joinSegments, locateJoinedIndex } from '../../../src/core/word/identifyWord';
import type { SegmentLocation, TextSegment } from '../../../src/core/word/types';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = resolve(here, '../../fixtures/pdf');

export const fixturePath = (name: string): string => resolve(FIXTURE_DIR, `${name}.pdf`);

export const readFixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(fixturePath(name)));

/**
 * Builds the engine as it is used under Node.
 *
 * PDF.js ships a dedicated legacy build for environments without a browser;
 * the production renderer injects the browser build into the very same
 * adapter, which is what makes these tests meaningful.
 */
export const createNodeEngine = async (): Promise<PdfEngine> => {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  const standardFontDataUrl = `${
    pathToFileURL(resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts')).href
  }/`;

  return createPdfjsEngine(pdfjs, { standardFontDataUrl, verbosity: 0 });
};

/**
 * Maps an index in the joined page text back to a text-layer location.
 *
 * The production mapping is used deliberately: a test helper with its own
 * copy of this arithmetic would stop testing the code that ships.
 */
export const locationOfIndex = (
  segments: readonly TextSegment[],
  index: number,
): SegmentLocation => {
  const location = locateJoinedIndex(segments, index);

  if (location === null) {
    throw new Error(`index ${index} is outside the page text`);
  }

  return location;
};

export const pageText = (segments: readonly TextSegment[]): string => joinSegments(segments).text;
