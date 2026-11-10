/**
 * Minimal result type.
 *
 * Expected failures (an unreadable document, a pointer that is not over a
 * word) are values rather than exceptions, so callers are forced to handle
 * them. Unexpected failures remain exceptions.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
