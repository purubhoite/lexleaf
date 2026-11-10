import { describe, expect, it } from 'vitest';

import { NO_TEXT_LAYER_MESSAGE, UNABLE_TO_OPEN_MESSAGE } from './messages';
import { classifyOpenFailure } from './openFailure';

/** Reproduces the shape of a PDF.js exception without importing the engine. */
const engineError = (name: string, message: string, code?: number): Error => {
  const error = new Error(message);
  error.name = name;
  if (code !== undefined) {
    Object.assign(error, { code });
  }
  return error;
};

describe('classifyOpenFailure', () => {
  it('recognises a document that needs a password', () => {
    const failure = classifyOpenFailure(engineError('PasswordException', 'No password given', 1));

    expect(failure.kind).toBe('password-required');
    expect(failure.cause).toBe('PasswordException: No password given');
  });

  it('distinguishes an incorrect password from a missing one', () => {
    expect(
      classifyOpenFailure(engineError('PasswordException', 'Incorrect Password', 2)).kind,
    ).toBe('password-incorrect');
  });

  it('recognises a damaged document', () => {
    const failure = classifyOpenFailure(
      engineError('InvalidPDFException', 'Invalid PDF structure.'),
    );

    expect(failure.kind).toBe('corrupt');
    expect(failure.message).toBe(UNABLE_TO_OPEN_MESSAGE);
  });

  it('recognises a file that is no longer there', () => {
    expect(classifyOpenFailure(engineError('MissingPDFException', 'Missing PDF')).kind).toBe(
      'missing',
    );
  });

  it('falls back to unsupported for unknown engine errors', () => {
    const failure = classifyOpenFailure(engineError('UnknownErrorException', 'something broke'));

    expect(failure.kind).toBe('unsupported');
    expect(failure.message).toBe(UNABLE_TO_OPEN_MESSAGE);
  });

  it('handles a thrown value that is not an error', () => {
    const failure = classifyOpenFailure('boom');

    expect(failure.kind).toBe('unsupported');
    expect(failure.cause).toBe('UnknownError: boom');
  });

  it('uses the wording required by the specification', () => {
    expect(UNABLE_TO_OPEN_MESSAGE).toBe(
      'Unable to open this PDF.\n\nThe file may be corrupted, encrypted, or unsupported.',
    );
    expect(NO_TEXT_LAYER_MESSAGE).toBe(
      'This PDF does not contain selectable text.\nWord lookup is unavailable for this document.',
    );
  });
});
