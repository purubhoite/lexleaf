import { AI_UNCONFIGURED } from '@shared/ipc/aiContracts';
import type { AiBridge } from '@shared/ipc/contracts';

/**
 * An AI bridge that answers "no provider is configured".
 *
 * This is the shipped default, not a degraded mode: with nothing
 * configured the reader behaves exactly as it did in Milestone 4, and the
 * popup shows no explanation control. Tests written before Milestone 5
 * get this stub so they keep describing the reader they were written
 * about, and every one of them is also a check that reading survives the
 * feature being absent.
 */
export const unconfiguredAiBridge = (): AiBridge => ({
  status: () => Promise.resolve(AI_UNCONFIGURED),
  storedExplanation: () => Promise.resolve(null),
  explain: () => Promise.resolve({ ok: false, error: { kind: 'not-configured' } }),
  cancel: () => Promise.resolve(),
});
