import { beforeAll, describe, expect, it } from 'vitest';

import { NO_TEXT_LAYER_MESSAGE, UNABLE_TO_OPEN_MESSAGE } from '../../src/core/pdf/messages';
import type { PdfEngine } from '../../src/core/pdf/pdfEngine';
import { identifyWordAt } from '../../src/core/word/identifyWord';
import { createNodeEngine, readFixture } from './support/corpus';

/** What the engine does when a document cannot be read, or carries no text. */

let engine: PdfEngine;

beforeAll(async () => {
  engine = await createNodeEngine();
});

describe('N — a scanned page with no text layer', () => {
  it('opens, but reports that no text is available', async () => {
    const result = await engine.open({
      bytes: await readFixture('n-scanned-no-text'),
      label: 'n-scanned-no-text',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const page = await result.value.getPageText(1);

    expect(page.hasTextLayer).toBe(false);
    expect(identifyWordAt(page.segments, { segmentIndex: 0, charOffset: 0 })).toBeNull();
    expect(NO_TEXT_LAYER_MESSAGE).toContain('does not contain selectable text');

    await result.value.close();
  });
});

describe('O — a password protected document', () => {
  it('reports that a password is required instead of failing opaquely', async () => {
    const result = await engine.open({
      bytes: await readFixture('o-encrypted'),
      label: 'o-encrypted',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('password-required');
    expect(result.error.cause).toContain('PasswordException');
  });

  it('distinguishes a wrong password', async () => {
    const result = await engine.open({
      bytes: await readFixture('o-encrypted'),
      label: 'o-encrypted',
      password: 'not-the-password',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('password-incorrect');
  });

  it('opens and yields words once the password is supplied', async () => {
    const result = await engine.open({
      bytes: await readFixture('o-encrypted'),
      label: 'o-encrypted',
      password: 'reader',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const page = await result.value.getPageText(1);

    expect(page.hasTextLayer).toBe(true);

    await result.value.close();
  });
});

describe('P — a damaged document', () => {
  it('returns a controlled failure rather than throwing', async () => {
    const result = await engine.open({ bytes: await readFixture('p-corrupt'), label: 'p-corrupt' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('corrupt');
    expect(result.error.message).toBe(UNABLE_TO_OPEN_MESSAGE);
  });
});

describe('a file that is not a PDF at all', () => {
  it('is reported as unopenable', async () => {
    const result = await engine.open({
      bytes: new TextEncoder().encode('this is not a PDF'),
      label: 'not-a-pdf.txt',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).toBe(UNABLE_TO_OPEN_MESSAGE);
  });

  it('is reported as unopenable when the data is empty', async () => {
    const result = await engine.open({ bytes: new Uint8Array(0), label: 'empty' });

    expect(result.ok).toBe(false);
  });
});

describe('the caller keeps ownership of the bytes', () => {
  it('can open the same buffer twice', async () => {
    const bytes = await readFixture('a-standard-prose');

    const first = await engine.open({ bytes, label: 'first' });
    const second = await engine.open({ bytes, label: 'second' });

    expect(first.ok && second.ok).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(0);

    if (first.ok) await first.value.close();
    if (second.ok) await second.value.close();
  });
});

describe('M7.5 — owner-password-only and recovered malformed documents', () => {
  it('opens the owner-password-only fixture without a password', async () => {
    const result = await engine.open({
      bytes: await readFixture('t-owner-password-only'),
      label: 't-owner-password-only',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pageCount).toBe(1);
    await result.value.close();
  });

  it('recovers the invalid-xref fixture deterministically', async () => {
    const expected = [
      'The lighthouse keeper watched the harbour empty itself of boats, one patient hull at a time, until',
      'only the old ferry remained. She had read every book the mainland sent her, and the margins of each',
      'were crowded with questions nobody had answered. Tonight the lamp turned above her with its',
      'familiar complaint, a sound she had long ago stopped hearing. The weather report promised a storm',
      'that would arrive before midnight and leave behind the kind of silence that makes a person',
      'reconsider their choices.',
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await engine.open({
        bytes: await readFixture('u-invalid-xref-recovery'),
        label: 'u-invalid-xref-recovery',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pageCount).toBe(1);
      expect((await result.value.getPageText(1)).segments.map((segment) => segment.text)).toEqual(
        expected,
      );
      await result.value.close();
    }
  });
});
