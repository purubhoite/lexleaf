#!/usr/bin/env node
/**
 * Generates the PDF regression corpus used by the Milestone 1 spike.
 *
 * Every fixture is produced from text written for this repository, so the
 * corpus carries no third-party redistribution risk. The only embedded
 * third-party asset is the DejaVu font family (see tests/fixtures/pdf/README.md).
 *
 * Output is deterministic: creation/modification dates are pinned so that
 * regenerating the corpus produces identical files.
 *
 * Usage: node scripts/generate-pdf-fixtures.mjs
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = process.env.M75_OUTPUT_DIR ?? join(projectRoot, 'tests/fixtures/pdf');
const M75_CJK_FONT =
  process.env.M75_CJK_FONT ?? '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf';
const M75_UNICODE_FONT =
  process.env.M75_UNICODE_FONT ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const M75_QPDF = process.env.M75_QPDF ?? 'qpdf';
const DEJAVU_SERIF = '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf';
const PINNED_DATE = new Date('2026-01-01T00:00:00Z');
const REQUIRED_QPDF_VERSION = '12.4.2';

const PAGE = { width: 595.28, height: 841.89 }; // A4 points
const MARGIN = 56;

const preflight = async () => {
  let versionOutput;
  try {
    versionOutput = execFileSync(M75_QPDF, ['--version'], { encoding: 'utf8' });
  } catch (error) {
    const detail = error?.message ?? String(error);
    throw new Error(
      `M7.5 preflight: qpdf 12.4.2 is required; could not execute ${M75_QPDF}: ${detail}`,
      { cause: error },
    );
  }
  const actualVersion = versionOutput.match(/qpdf version\s+([^\s]+)/i)?.[1] ?? 'unknown';
  if (actualVersion !== REQUIRED_QPDF_VERSION) {
    throw new Error(
      `M7.5 preflight: qpdf version ${REQUIRED_QPDF_VERSION} is required; found ${actualVersion}`,
    );
  }

  for (const [label, path] of [
    ['CJK', M75_CJK_FONT],
    ['Unicode', M75_UNICODE_FONT],
  ]) {
    if (!existsSync(path)) {
      throw new Error(`M7.5 preflight: required ${label} font does not exist: ${path}`);
    }
    try {
      const probe = await PDFDocument.create();
      probe.registerFontkit(fontkit);
      await probe.embedFont(readFileSync(path), { subset: true });
    } catch (error) {
      throw new Error(
        `M7.5 preflight: required ${label} font cannot be embedded (${path}): ${error?.message ?? error}`,
        { cause: error },
      );
    }
  }
};

await preflight();
mkdirSync(outputDir, { recursive: true });

/** Pins metadata so regeneration is byte-stable. */
const newDocument = async (title) => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setProducer('intelligent-pdf-reader fixture generator');
  pdf.setCreator('intelligent-pdf-reader fixture generator');
  pdf.setCreationDate(PINNED_DATE);
  pdf.setModificationDate(PINNED_DATE);
  return pdf;
};

const save = async (pdf, name) => {
  const bytes = await pdf.save({ useObjectStreams: false });
  writeFileSync(join(outputDir, name), bytes);
  return { name, bytes: bytes.length };
};

/** Greedy line breaker: returns lines that fit within `width`. */
const wrapLines = (text, font, size, width) => {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter((w) => w.length > 0);
    let current = [];
    for (const word of words) {
      const candidate = [...current, word];
      if (font.widthOfTextAtSize(candidate.join(' '), size) > width && current.length > 0) {
        lines.push(current);
        current = [word];
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
};

/**
 * Draws a paragraph. When `justify` is set, inter-word gaps are widened so the
 * line reaches the right margin — this is what makes PDF viewers emit many
 * separate positioned text runs, which is exactly the hard case for word
 * identification.
 */
const drawParagraph = (page, text, { font, size, x, y, width, lineHeight, justify = false }) => {
  const lines = wrapLines(text, font, size, width);
  let cursorY = y;

  lines.forEach((words, lineIndex) => {
    const isLastLine = lineIndex === lines.length - 1;
    if (justify && !isLastLine && words.length > 1) {
      const textWidth = words.reduce((sum, w) => sum + font.widthOfTextAtSize(w, size), 0);
      const gap = (width - textWidth) / (words.length - 1);
      let cursorX = x;
      for (const word of words) {
        page.drawText(word, { x: cursorX, y: cursorY, size, font });
        cursorX += font.widthOfTextAtSize(word, size) + gap;
      }
    } else {
      page.drawText(words.join(' '), { x, y: cursorY, size, font });
    }
    cursorY -= lineHeight;
  });

  return cursorY;
};

const PROSE = [
  'The lighthouse keeper watched the harbour empty itself of boats, one patient hull at a',
  'time, until only the old ferry remained. She had read every book the mainland sent her,',
  'and the margins of each were crowded with questions nobody had answered. Tonight the',
  'lamp turned above her with its familiar complaint, a sound she had long ago stopped',
  'hearing. The weather report promised a storm that would arrive before midnight and leave',
  'behind the kind of silence that makes a person reconsider their choices.',
].join(' ');

const results = [];

// ---------------------------------------------------------------- A. prose
{
  const pdf = await newDocument('Standard prose');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  drawParagraph(page, PROSE, {
    font,
    size: 12,
    x: MARGIN,
    y: PAGE.height - MARGIN,
    width: PAGE.width - MARGIN * 2,
    lineHeight: 18,
  });
  results.push(await save(pdf, 'a-standard-prose.pdf'));
}

// --------------------------------------------------------- B. multi-column
{
  const pdf = await newDocument('Multi-column article');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const bold = pdf.embedStandardFont(StandardFonts.TimesRomanBold);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const columnWidth = (PAGE.width - MARGIN * 2 - 24) / 2;

  page.drawText('Observations on Harbour Illumination', {
    x: MARGIN,
    y: PAGE.height - MARGIN,
    size: 14,
    font: bold,
  });

  const columnText =
    'Prior studies of coastal illumination assume a stationary observer. We relax that ' +
    'assumption and report measurements gathered from a moving vessel. The apparatus ' +
    'recorded luminance at fixed intervals throughout the night, producing a dataset of ' +
    'considerable density. Results indicate substantial variation attributable to ' +
    'atmospheric moisture rather than to lamp performance.';

  for (const columnIndex of [0, 1]) {
    drawParagraph(page, columnText, {
      font,
      size: 10,
      x: MARGIN + columnIndex * (columnWidth + 24),
      y: PAGE.height - MARGIN - 30,
      width: columnWidth,
      lineHeight: 14,
      justify: true,
    });
  }
  results.push(await save(pdf, 'b-multi-column.pdf'));
}

// ------------------------------------------------------------- C. justified
{
  const pdf = await newDocument('Justified text');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  drawParagraph(page, `${PROSE} ${PROSE}`, {
    font,
    size: 12,
    x: MARGIN,
    y: PAGE.height - MARGIN,
    width: PAGE.width - MARGIN * 2,
    lineHeight: 19,
    justify: true,
  });
  results.push(await save(pdf, 'c-justified.pdf'));
}

// ------------------------------------------------------------ D. font sizes
{
  const pdf = await newDocument('Font sizes');
  const font = pdf.embedStandardFont(StandardFonts.Helvetica);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  for (const size of [7, 9, 12, 18, 28, 40]) {
    page.drawText(`Measurement at ${size} points: luminous intensity varies`, {
      x: MARGIN,
      y,
      size,
      font,
    });
    y -= size * 2.1;
  }
  results.push(await save(pdf, 'd-font-sizes.pdf'));
}

// ----------------------------------------------------------- E. punctuation
{
  const pdf = await newDocument('Punctuation');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const samples = [
    'ambivalence,',
    'ambivalence.',
    '"ambivalence"',
    '(ambivalence)',
    '[ambivalence]',
    'ambivalence:',
    'ambivalence;',
    'ambivalence!',
    'ambivalence?',
    '...ambivalence...',
    '-ambivalence-',
    '/ambivalence/',
    '*ambivalence*',
  ];
  let y = PAGE.height - MARGIN;
  for (const sample of samples) {
    page.drawText(sample, { x: MARGIN, y, size: 14, font });
    y -= 26;
  }
  results.push(await save(pdf, 'e-punctuation.pdf'));
}

// ----------------------------------------------------------- F. hyphenation
{
  const pdf = await newDocument('Hyphenation');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const lines = [
    'A well-known keeper maintained the light.',
    'The state-of-the-art apparatus recorded everything.',
    'Self-evident conclusions require no further argument.',
    'The measurements were inconclusive and the committee recon-',
    'sidered the entire programme the following morning.',
    'An em-dash pause — like this — interrupts the sentence.',
  ];
  let y = PAGE.height - MARGIN;
  for (const line of lines) {
    page.drawText(line, { x: MARGIN, y, size: 13, font });
    y -= 30;
  }
  results.push(await save(pdf, 'f-hyphenation.pdf'));
}

// ----------------------------------------------------------- G. apostrophes
{
  const pdf = await newDocument('Apostrophes');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const lines = [
    "don't stop",
    "the author's intent",
    "several users' expectations",
    "it's the keeper's lamp",
    "o'clock",
    "'quoted' material",
  ];
  let y = PAGE.height - MARGIN;
  for (const line of lines) {
    page.drawText(line, { x: MARGIN, y, size: 14, font });
    y -= 28;
  }
  results.push(await save(pdf, 'g-apostrophes.pdf'));
}

// ------------------------------------------------- H. ligatures and Unicode
{
  const pdf = await newDocument('Ligatures and Unicode');
  const serif = await pdf.embedFont(readFileSync(DEJAVU_SERIF), { subset: true });
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const lines = [
    'ligature \uFB01nd and \uFB02ourish and \uFB00ord',
    'diacritics: café naïve résumé Grüße',
    'curly quotes: \u201Cambivalence\u201D and \u2018brief\u2019',
    'dashes: em \u2014 dash and en \u2013 dash',
    'ellipsis: continued\u2026 then stopped',
    'non-breaking\u00A0space pair',
  ];
  let y = PAGE.height - MARGIN;
  for (const line of lines) {
    page.drawText(line, { x: MARGIN, y, size: 14, font: serif });
    y -= 30;
  }
  results.push(await save(pdf, 'h-ligatures-unicode.pdf'));
}

// ------------------------------------------------------ I. headers/footers
{
  const pdf = await newDocument('Headers and footers');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const italic = pdf.embedStandardFont(StandardFonts.TimesRomanItalic);
  for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    page.drawText('HARBOUR ILLUMINATION QUARTERLY', {
      x: MARGIN,
      y: PAGE.height - 34,
      size: 9,
      font: italic,
      color: rgb(0.35, 0.35, 0.35),
    });
    drawParagraph(page, PROSE, {
      font,
      size: 12,
      x: MARGIN,
      y: PAGE.height - MARGIN - 20,
      width: PAGE.width - MARGIN * 2,
      lineHeight: 18,
    });
    page.drawText(`page ${pageNumber} of 3`, {
      x: PAGE.width / 2 - 24,
      y: 30,
      size: 9,
      font: italic,
      color: rgb(0.35, 0.35, 0.35),
    });
  }
  results.push(await save(pdf, 'i-headers-footers.pdf'));
}

// ------------------------------------------------------------- J. footnotes
{
  const pdf = await newDocument('Footnotes');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const bodyBottom = drawParagraph(page, PROSE, {
    font,
    size: 12,
    x: MARGIN,
    y: PAGE.height - MARGIN,
    width: PAGE.width - MARGIN * 2,
    lineHeight: 18,
  });
  // Superscript reference markers sit slightly above the baseline.
  page.drawText('1', { x: MARGIN + 180, y: bodyBottom + 23, size: 7, font });
  page.drawText('2', { x: MARGIN + 320, y: bodyBottom + 5, size: 7, font });
  page.drawLine({
    start: { x: MARGIN, y: 120 },
    end: { x: MARGIN + 160, y: 120 },
    thickness: 0.5,
  });
  page.drawText('1. Luminance was recorded hourly; see appendix for the apparatus.', {
    x: MARGIN,
    y: 104,
    size: 8,
    font,
  });
  page.drawText('2. The ferry timetable is reproduced with the operator\u2019s permission.', {
    x: MARGIN,
    y: 90,
    size: 8,
    font,
  });
  results.push(await save(pdf, 'j-footnotes.pdf'));
}

// --------------------------------------------------------------- K. rotated
{
  const pdf = await newDocument('Rotated pages and text');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);

  for (const rotation of [90, 180, 270]) {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    page.setRotation(degrees(rotation));
    drawParagraph(page, PROSE, {
      font,
      size: 12,
      x: MARGIN,
      y: PAGE.height - MARGIN,
      width: PAGE.width - MARGIN * 2,
      lineHeight: 18,
    });
  }

  // A page that is not rotated, but whose text runs are.
  const slanted = pdf.addPage([PAGE.width, PAGE.height]);
  slanted.drawText('vertical ascending caption', {
    x: 80,
    y: 200,
    size: 14,
    font,
    rotate: degrees(90),
  });
  slanted.drawText('diagonal watermark sample', {
    x: 140,
    y: 520,
    size: 16,
    font,
    rotate: degrees(45),
  });
  slanted.drawText('upright reference line for comparison', {
    x: 80,
    y: 700,
    size: 14,
    font,
  });
  results.push(await save(pdf, 'k-rotated.pdf'));
}

// ----------------------------------------------------- L. unusual encodings
{
  const pdf = await newDocument('Unusual encodings');
  const serif = await pdf.embedFont(readFileSync(DEJAVU_SERIF), { subset: true });
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const lines = [
    'Greek: \u03B1\u03BC\u03C6\u03B9\u03B2\u03BF\u03BB\u03AF\u03B1 \u03BA\u03B1\u03B9 \u03C3\u03B1\u03C6\u03AE\u03BD\u03B5\u03B9\u03B1',
    'Cyrillic: \u0434\u0432\u0443\u0441\u043C\u044B\u0441\u043B\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u0438 \u044F\u0441\u043D\u043E\u0441\u0442\u044C',
    'Vietnamese: ti\u1EBFng Vi\u1EC7t r\u1EA5t \u0111\u1EB9p',
    'German sharp s: Stra\u00DFe und Gr\u00F6\u00DFe',
    'Mathematical: \u2211 x\u00B2 \u2264 \u221E and \u03C0 \u2248 3.14159',
    'Mixed script: the word \u03BB\u03CC\u03B3\u03BF\u03C2 inside English text',
  ];
  let y = PAGE.height - MARGIN;
  for (const line of lines) {
    page.drawText(line, { x: MARGIN, y, size: 13, font: serif });
    y -= 30;
  }
  results.push(await save(pdf, 'l-unusual-encoding.pdf'));
}

// ----------------------------------------------------------------- M. large
{
  const pdf = await newDocument('Large document');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const italic = pdf.embedStandardFont(StandardFonts.TimesRomanItalic);
  const PAGES = 400;
  for (let pageNumber = 1; pageNumber <= PAGES; pageNumber += 1) {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    page.drawText(`Chapter ${Math.ceil(pageNumber / 20)}`, {
      x: MARGIN,
      y: PAGE.height - 34,
      size: 9,
      font: italic,
    });
    let y = PAGE.height - MARGIN - 20;
    for (let block = 0; block < 3; block += 1) {
      y =
        drawParagraph(page, `Page ${pageNumber}. ${PROSE}`, {
          font,
          size: 11,
          x: MARGIN,
          y,
          width: PAGE.width - MARGIN * 2,
          lineHeight: 16,
          justify: true,
        }) - 10;
    }
    page.drawText(String(pageNumber), { x: PAGE.width / 2, y: 30, size: 9, font });
  }
  results.push(await save(pdf, 'm-large.pdf'));
}

// ------------------------------------------------- N. scanned (no text layer)
{
  const imagePath = join(outputDir, '.scan-source.png');
  execFileSync('convert', [
    '-size',
    '1240x520',
    'xc:white',
    '-gravity',
    'northwest',
    '-pointsize',
    '34',
    '-fill',
    'black',
    '-annotate',
    '+40+40',
    'This page was scanned from paper.\nIt contains no selectable text layer.\nWord lookup must report that clearly.',
    '-noise',
    '1',
    imagePath,
  ]);

  const pdf = await newDocument('Scanned page without text layer');
  const png = await pdf.embedPng(readFileSync(imagePath));
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const scale = (PAGE.width - MARGIN * 2) / png.width;
  page.drawImage(png, {
    x: MARGIN,
    y: PAGE.height - MARGIN - png.height * scale,
    width: png.width * scale,
    height: png.height * scale,
  });
  results.push(await save(pdf, 'n-scanned-no-text.pdf'));
  execFileSync('rm', ['-f', imagePath]);
}

// ------------------------------------------------------------- O. encrypted
{
  const plainPath = join(outputDir, '.encrypt-source.pdf');
  const pdf = await newDocument('Password protected');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  drawParagraph(page, `Protected document. ${PROSE}`, {
    font,
    size: 12,
    x: MARGIN,
    y: PAGE.height - MARGIN,
    width: PAGE.width - MARGIN * 2,
    lineHeight: 18,
  });
  writeFileSync(plainPath, await pdf.save({ useObjectStreams: false }));

  // qpdf applies standard security handler encryption (user password "reader").
  execFileSync(M75_QPDF, [
    '--encrypt',
    'reader',
    'ownerpass',
    '256',
    '--',
    plainPath,
    join(outputDir, 'o-encrypted.pdf'),
  ]);
  execFileSync('rm', ['-f', plainPath]);
  results.push({
    name: 'o-encrypted.pdf',
    bytes: readFileSync(join(outputDir, 'o-encrypted.pdf')).length,
  });
}

// --------------------------------------------------------------- P. corrupt
{
  // Valid header, truncated body: the parser must fail in a controlled way.
  const broken = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n'),
    Buffer.from('%% file truncated here on purpose\n'),
  ]);
  writeFileSync(join(outputDir, 'p-corrupt.pdf'), broken);
  results.push({ name: 'p-corrupt.pdf', bytes: broken.length });
}

// ----------------------------------------------------------- M7.5 extension
{
  const pdf = await newDocument('M7.5 horizontal Japanese and mixed CJK');
  const font = await pdf.embedFont(readFileSync(M75_CJK_FONT), { subset: true });
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  page.drawText('日本語の文章 中文测试 Mixed Latin and CJK.', {
    x: MARGIN,
    y: PAGE.height - MARGIN,
    size: 18,
    font,
  });
  results.push(await save(pdf, 'r-cjk-mixed.pdf'));
}
{
  const pdf = await newDocument('M7.5 Unicode');
  const font = await pdf.embedFont(readFileSync(M75_UNICODE_FONT), { subset: true });
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  page.drawText('Combining e\u0301 and Hebrew שלום and Arabic مرحبا and astral 😀.', {
    x: MARGIN,
    y: PAGE.height - MARGIN,
    size: 16,
    font,
  });
  results.push(await save(pdf, 's-unicode-representative.pdf'));
}
{
  const plainPath = join(outputDir, '.m75-owner-source.pdf');
  const pdf = await newDocument('M7.5 owner password only');
  const font = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  page.drawText('Owner password only; permissions are intentionally restricted.', {
    x: MARGIN,
    y: PAGE.height - MARGIN,
    size: 14,
    font,
  });
  writeFileSync(plainPath, await pdf.save({ useObjectStreams: false }));
  execFileSync(M75_QPDF, [
    '--encrypt',
    '',
    'ownerpass',
    '256',
    '--print=none',
    '--modify=none',
    '--extract=n',
    '--',
    plainPath,
    join(outputDir, 't-owner-password-only.pdf'),
  ]);
  execFileSync('rm', ['-f', plainPath]);
  results.push({
    name: 't-owner-password-only.pdf',
    bytes: readFileSync(join(outputDir, 't-owner-password-only.pdf')).length,
  });
}
{
  const source = readFileSync(join(projectRoot, 'tests/fixtures/pdf/a-standard-prose.pdf'));
  const marker = Buffer.from('startxref\n');
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('M7.5 invalid-xref source has no startxref');
  const end = source.indexOf(Buffer.from('%%EOF'), at);
  const malformed = Buffer.concat([
    source.subarray(0, at),
    Buffer.from('startxref\n999999\n'),
    source.subarray(end < 0 ? source.length : end),
  ]);
  writeFileSync(join(outputDir, 'u-invalid-xref-recovery.pdf'), malformed);
  results.push({ name: 'u-invalid-xref-recovery.pdf', bytes: malformed.length });
}

// --------------------------------------------------------------- empty page
{
  const pdf = await newDocument('Page without any content');
  pdf.addPage([PAGE.width, PAGE.height]);
  results.push(await save(pdf, 'q-empty-page.pdf'));
}

const total = results.reduce((sum, r) => sum + r.bytes, 0);
for (const { name, bytes } of results) {
  console.log(`${name.padEnd(28)} ${(bytes / 1024).toFixed(1).padStart(8)} KiB`);
}
console.log(`${'total'.padEnd(28)} ${(total / 1024).toFixed(1).padStart(8)} KiB`);

if (!existsSync(join(outputDir, 'a-standard-prose.pdf'))) {
  throw new Error('fixture generation did not produce the expected output');
}
