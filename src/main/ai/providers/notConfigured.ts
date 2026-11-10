import { err } from '@core/result';
import type { ContextExplainer } from '@core/ai/types';

/**
 * The default provider: there isn't one.
 *
 * With no configuration the application makes no AI network request at
 * all, and the popup shows no Explain control (reviewer decision D2). This
 * explainer exists so that "unconfigured" is an ordinary value flowing
 * through the same port as every other provider, rather than a null check
 * scattered through the service.
 *
 * It performs no I/O of any kind.
 */
export const createNotConfiguredExplainer = (): ContextExplainer => ({
  describe: () => ({ provider: 'none', model: 'none', remote: false }),
  explain: () => Promise.resolve(err({ kind: 'not-configured' } as const)),
});
