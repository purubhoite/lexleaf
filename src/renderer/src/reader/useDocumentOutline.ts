import { useEffect, useState } from 'react';

import type { PdfOutlineEntry } from '@core/pdf/outline';
import type { OpenedPdf } from '@core/pdf/pdfEngine';

/**
 * The open document's table of contents.
 *
 * It is read once per document, after the document is already on screen:
 * nothing waits for it. Until it arrives, and for a document that has
 * none, the list is empty. An outline that arrives for a document the
 * reader has since left is dropped.
 */

const NONE: readonly PdfOutlineEntry[] = [];

interface Loaded {
  readonly document: OpenedPdf;
  readonly entries: readonly PdfOutlineEntry[];
}

export const useDocumentOutline = (document: OpenedPdf | null): readonly PdfOutlineEntry[] => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (document === null) {
      return;
    }

    let current = true;

    void document.getOutline().then(
      (entries) => {
        if (current) {
          setLoaded({ document, entries });
        }
      },
      () => undefined,
    );

    return (): void => {
      current = false;
    };
  }, [document]);

  // Compared against the document rather than cleared in the effect, so a
  // newly opened document never shows the previous one's chapters, not
  // even for one frame.
  return loaded !== null && loaded.document === document ? loaded.entries : NONE;
};
