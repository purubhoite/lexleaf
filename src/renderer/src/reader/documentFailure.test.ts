import { describe, expect, it } from 'vitest';

import { DOCUMENT_FAILURE_REASONS, type DocumentFailure } from '@shared/ipc/contracts';

import { DOCUMENT_FAILURE_MESSAGES, describeDocumentFailure } from './documentFailure';

/**
 * The reader-facing half of the failure vocabulary (M7.2).
 *
 * Two properties are being protected here. The first is that every reason
 * has a sentence, so a reader is never shown a half-written message — the
 * defect 6.5 found in the application-details copy, where an unmapped
 * failure rendered `undefined` as nothing at all. The second is that no
 * sentence this module can produce contains a path, a separator or an
 * `errno`, whatever it is handed.
 */

const failure = (
  reason: (typeof DOCUMENT_FAILURE_REASONS)[number],
  name: string | null,
): DocumentFailure => ({ status: 'unreadable', reason, name });

describe('the document failure vocabulary', () => {
  it('has one sentence for each reason and no others', () => {
    expect(Object.keys(DOCUMENT_FAILURE_MESSAGES).sort()).toStrictEqual(
      [...DOCUMENT_FAILURE_REASONS].sort(),
    );
  });

  it('says something for every reason, named or not', () => {
    for (const reason of DOCUMENT_FAILURE_REASONS) {
      for (const name of ['harbour.pdf', null]) {
        const sentence = describeDocumentFailure(failure(reason, name));

        expect({ reason, name, endsProperly: sentence.trim().endsWith('.') }).toStrictEqual({
          reason,
          name,
          endsProperly: true,
        });
        expect(sentence).not.toContain('undefined');
        expect(sentence.length).toBeGreaterThan('x could not be opened.'.length);
      }
    }
  });

  it('keeps the sentence the recent list has shown since Milestone 2', () => {
    // `docs/DEVELOPMENT_PLAN.md`'s manual script quotes this wording for a
    // deleted recent document. The vocabulary changed underneath it; the
    // sentence did not.
    expect(describeDocumentFailure(failure('missing', 'moved-away.pdf'))).toBe(
      'moved-away.pdf could not be opened. It may have been moved, renamed or deleted.',
    );
  });

  it('falls back to a subject rather than an empty space when there is no name', () => {
    expect(describeDocumentFailure(failure('missing', null))).toBe(
      'That document could not be opened. It may have been moved, renamed or deleted.',
    );
    expect(describeDocumentFailure(failure('missing', '   '))).toMatch(/^That document/u);
  });

  it('lets no separator, errno or scheme into a rendered sentence', () => {
    // The reason is typed, so this is about the one piece of free-ish text
    // left — the name — and about the sentences themselves.
    const hostile = [
      '/home/reader/private/Medical Report.pdf',
      'C:\\Users\\reader\\Divorce Papers.pdf',
      'file:///etc/passwd',
      "ENOENT: no such file or directory, stat '/x.pdf'",
    ];

    for (const name of hostile) {
      for (const reason of DOCUMENT_FAILURE_REASONS) {
        const sentence = describeDocumentFailure(failure(reason, name));

        expect({ name, reason, sentence }).toStrictEqual({
          name,
          reason,
          sentence: expect.not.stringContaining('/') as string,
        });
        expect(sentence).not.toContain('\\');
      }
    }
  });

  it('never mentions the machine in any of its sentences', () => {
    const forbidden = [
      '/',
      '\\',
      'ENOENT',
      'EACCES',
      'EISDIR',
      'errno',
      'file://',
      'http',
      'Error',
      'exception',
      'undefined',
      'null',
    ];

    for (const [reason, sentence] of Object.entries(DOCUMENT_FAILURE_MESSAGES)) {
      for (const token of forbidden) {
        expect({ reason, token, sentence }).toStrictEqual({
          reason,
          token,
          sentence: expect.not.stringContaining(token) as string,
        });
      }
    }
  });
});
