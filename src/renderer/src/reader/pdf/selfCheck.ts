import { TextLayer, type PDFPageProxy } from 'pdfjs-dist';

import type { OpenedPdf } from '@core/pdf/pdfEngine';
import type { TextSegment } from '@core/word/types';

import { readTextLayer } from './textLayerIndex';

/**
 * Checks that the text layer the user interacts with says the same thing as
 * the text the engine reports.
 *
 * Word identification reads the DOM, while the automated engine tests read
 * `getTextContent()`. This comparison - run inside the real application, on a
 * real document - is what connects the two, and it is the evidence behind the
 * "no stale text layer" and "DOM equals engine" claims in the spike report.
 */

export interface PageCheck {
  readonly pageNumber: number;
  readonly matches: boolean;
  readonly domSegments: number;
  readonly engineSegments: number;
  readonly firstDifference: string | null;
}

export interface SelfCheckReport {
  readonly checked: number;
  readonly mismatches: readonly PageCheck[];
  readonly milliseconds: number;
}

const sameSegments = (
  dom: readonly TextSegment[],
  engine: readonly TextSegment[],
): string | null => {
  const length = Math.max(dom.length, engine.length);

  for (let index = 0; index < length; index += 1) {
    const left = dom[index];
    const right = engine[index];

    if (left?.text !== right?.text || left?.endsLine !== right?.endsLine) {
      return `segment ${index}: text layer ${JSON.stringify(left)} vs engine ${JSON.stringify(right)}`;
    }
  }

  return null;
};

const renderTextLayerOffScreen = async (page: PDFPageProxy): Promise<HTMLElement> => {
  const container = document.createElement('div');
  const textLayer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport: page.getViewport({ scale: 1 }),
  });

  await textLayer.render();

  return container;
};

/**
 * @param pageNumbers pages to check; a long document is sampled by the caller
 */
export const runTextLayerSelfCheck = async (
  document_: OpenedPdf,
  pageNumbers: readonly number[],
): Promise<SelfCheckReport> => {
  const started = performance.now();
  const mismatches: PageCheck[] = [];

  for (const pageNumber of pageNumbers) {
    const page = (await document_.getNativePage(pageNumber)) as PDFPageProxy;
    const container = await renderTextLayerOffScreen(page);
    const dom = readTextLayer(container);
    const engine = await document_.getPageText(pageNumber);
    const difference = sameSegments(dom.segments, engine.segments);

    if (difference !== null) {
      mismatches.push({
        pageNumber,
        matches: false,
        domSegments: dom.segments.length,
        engineSegments: engine.segments.length,
        firstDifference: difference,
      });
    }
  }

  return {
    checked: pageNumbers.length,
    mismatches,
    milliseconds: Math.round(performance.now() - started),
  };
};
