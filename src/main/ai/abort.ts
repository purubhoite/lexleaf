import type { AiFailure } from '@core/ai/types';

/**
 * Why a request was aborted.
 *
 * A timeout and a cancellation unwind through exactly the same
 * `AbortSignal`, but they are different events for the reader: one is a
 * failure with a Retry, the other is not an error at all. The reason
 * carried on the signal is how the adapter tells them apart without
 * inspecting a provider's exception text.
 */

export const TIMEOUT_ABORT_REASON = 'explanation-timeout';

export const CANCELLED_ABORT_REASON = 'explanation-cancelled';

export const failureForAbort = (signal: AbortSignal): AiFailure =>
  signal.reason === TIMEOUT_ABORT_REASON ? { kind: 'timeout' } : { kind: 'cancelled' };
