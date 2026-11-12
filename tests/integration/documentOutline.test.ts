import { describe, expect, it } from 'vitest';

import { createNodeEngine, readFixture } from './support/corpus';

/**
 * The table of contents, read by the real engine from a real file.
 *
 * The PDF is written out here, small enough to read: three pages and an
 * outline that points at them in each of the ways a PDF can — an explicit
 * destination, a named one, a GoTo action, a page index — plus one entry
 * that leads out of the document and one that leads nowhere.
 */

const buildPdfWithOutline = (): Uint8Array => {
  const objects: string[] = [
    /* 1 */ '<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /Dests 13 0 R >>',
    /* 2 */ '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    /* 3 */ '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    /* 4 */ '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    /* 5 */ '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    /* 6 */ '<< /Type /Outlines /First 7 0 R /Last 12 0 R /Count 6 >>',
    /* 7 */ '<< /Title (Part One) /Parent 6 0 R /Next 9 0 R /First 8 0 R /Last 8 0 R /Count 1 /Dest [3 0 R /Fit] >>',
    /* 8 */ '<< /Title (Chapter  1) /Parent 7 0 R /Dest [4 0 R /XYZ 0 200 0] >>',
    /* 9 */ '<< /Title (Named chapter) /Parent 6 0 R /Prev 7 0 R /Next 10 0 R /Dest /chapter-three >>',
    /* 10 */ '<< /Title (By action) /Parent 6 0 R /Prev 9 0 R /Next 11 0 R /A << /S /GoTo /D [4 0 R /Fit] >> >>',
    /* 11 */ '<< /Title (Publisher) /Parent 6 0 R /Prev 10 0 R /Next 12 0 R /A << /S /URI /URI (https://example.com/) >> >>',
    /* 12 */ '<< /Title (Missing name) /Parent 6 0 R /Prev 11 0 R /Dest /no-such-destination >>',
    /* 13 */ '<< /chapter-three [5 0 R /Fit] >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });

  const xref = body.length;

  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;

  return new TextEncoder().encode(body);
};

describe('a document’s table of contents', () => {
  it('is read with the page each entry leads to', async () => {
    const engine = await createNodeEngine();
    const opened = await engine.open({ bytes: buildPdfWithOutline(), label: 'outline.pdf' });

    expect(opened.ok).toBe(true);

    if (!opened.ok) {
      return;
    }

    try {
      expect(opened.value.pageCount).toBe(3);
      await expect(opened.value.getOutline()).resolves.toStrictEqual([
        { title: 'Part One', pageNumber: 1, depth: 0 },
        { title: 'Chapter 1', pageNumber: 2, depth: 1 },
        { title: 'Named chapter', pageNumber: 3, depth: 0 },
        { title: 'By action', pageNumber: 2, depth: 0 },
        { title: 'Publisher', pageNumber: null, depth: 0 },
        { title: 'Missing name', pageNumber: null, depth: 0 },
      ]);
    } finally {
      await opened.value.close();
    }
  });

  it('is empty for a document that has none', async () => {
    const engine = await createNodeEngine();
    const opened = await engine.open({
      bytes: await readFixture('a-standard-prose'),
      label: 'a-standard-prose.pdf',
    });

    expect(opened.ok).toBe(true);

    if (!opened.ok) {
      return;
    }

    try {
      await expect(opened.value.getOutline()).resolves.toStrictEqual([]);
    } finally {
      await opened.value.close();
    }
  });
});
