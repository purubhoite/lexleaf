import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import { createPdfjsEngine } from '@core/pdf/pdfjs/pdfjsEngine';
import type { PdfEngine } from '@core/pdf/pdfEngine';

/**
 * The engine instance used by the application.
 *
 * This is the only place in the renderer that names a PDF.js build or
 * configures its worker; everything else depends on the {@link PdfEngine}
 * port. The worker file is emitted by the bundler and served from the
 * application origin, which satisfies the `worker-src 'self'` policy.
 *
 * The *legacy* build is deliberate. PDF.js 6.3 calls `Math.sumPrecise`
 * (ES2026, Chrome 147+) while rebuilding embedded fonts and measuring text;
 * Electron 41 ships Chromium 146, where that method does not exist, and the
 * modern build then fails to open documents whose fonts take that path (the
 * encrypted corpus fixture failed with "Math.sumPrecise is not a function").
 * The legacy build carries the polyfill. See docs/PDF_SPIKE_REPORT.md.
 */
export const createRendererPdfEngine = (): PdfEngine =>
  createPdfjsEngine(pdfjs, { workerSrc, verbosity: 0 });
