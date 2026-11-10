import {
  OPEN_CANCELLED_MESSAGE,
  PASSWORD_INCORRECT_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
  UNABLE_TO_OPEN_MESSAGE,
} from './messages';
import type { PdfOpenFailure, PdfOpenFailureKind } from './types';

const MESSAGES: Record<PdfOpenFailureKind, string> = {
  'password-required': PASSWORD_REQUIRED_MESSAGE,
  'password-incorrect': PASSWORD_INCORRECT_MESSAGE,
  corrupt: UNABLE_TO_OPEN_MESSAGE,
  missing: UNABLE_TO_OPEN_MESSAGE,
  unsupported: UNABLE_TO_OPEN_MESSAGE,
  cancelled: OPEN_CANCELLED_MESSAGE,
};

/** PDF.js reports 1 when a password is needed and 2 when the given one is wrong. */
const PASSWORD_INCORRECT_CODE = 2;

interface ErrorShape {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
}

const describe = (error: unknown): ErrorShape => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: (error as { code?: unknown }).code };
  }
  return { name: 'UnknownError', message: String(error) };
};

const classifyKind = ({ name, code }: ErrorShape): PdfOpenFailureKind => {
  switch (name) {
    case 'PasswordException':
      return code === PASSWORD_INCORRECT_CODE ? 'password-incorrect' : 'password-required';
    case 'InvalidPDFException':
      return 'corrupt';
    case 'MissingPDFException':
      return 'missing';
    default:
      return 'unsupported';
  }
};

/** The failure reported when the caller aborted the open itself. */
export const cancelledOpenFailure = (): PdfOpenFailure => ({
  kind: 'cancelled',
  message: MESSAGES.cancelled,
  cause: 'AbortError: the open was cancelled',
});

/**
 * Translates an engine failure into the application's own taxonomy.
 *
 * Keeping this mapping in one tested function means nothing else inspects
 * PDF.js exception types, which is what allows the engine to be replaced
 * later (ADR-003).
 */
export const classifyOpenFailure = (error: unknown): PdfOpenFailure => {
  const shape = describe(error);
  const kind = classifyKind(shape);

  return { kind, message: MESSAGES[kind], cause: `${shape.name}: ${shape.message}` };
};
