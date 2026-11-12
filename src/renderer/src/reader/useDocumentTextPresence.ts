import { useEffect, useState } from 'react';

import type { OpenedPdf } from '@core/pdf/pdfEngine';
import { textPresenceSamplePages, type DocumentTextPresence } from '@core/pdf/textPresence';

/**
 * Whether the open document has any text to look words up in.
 *
 * A few pages spread through the document are read, one after another,
 * after the document is already on screen. The answer is `text` the moment
 * one of them has some, and `none` only when all of them were read and had
 * none. A page that cannot be read leaves the answer `unknown`: the reader
 * is told a document is a scan only when that is what was found.
 */

interface Known {
  readonly document: OpenedPdf;
  readonly presence: DocumentTextPresence;
}

export const useDocumentTextPresence = (document: OpenedPdf | null): DocumentTextPresence => {
  const [known, setKnown] = useState<Known | null>(null);

  useEffect(() => {
    if (document === null) {
      return;
    }

    let current = true;

    const look = async (): Promise<DocumentTextPresence> => {
      const pages = textPresenceSamplePages(document.pageCount);

      if (pages.length === 0) {
        return 'unknown';
      }

      for (const pageNumber of pages) {
        if (!current) {
          return 'unknown';
        }

        if ((await document.getPageText(pageNumber)).hasTextLayer) {
          return 'text';
        }
      }

      return 'none';
    };

    void look().then(
      (presence) => {
        if (current) {
          setKnown({ document, presence });
        }
      },
      () => undefined,
    );

    return (): void => {
      current = false;
    };
  }, [document]);

  return known !== null && known.document === document ? known.presence : 'unknown';
};
