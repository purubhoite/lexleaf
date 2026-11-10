import { describe, expect, it } from 'vitest';

import { DESKTOP_BRIDGE_KEY } from '@shared/ipc/contracts';

import { resolveDesktopBridge } from './desktopBridge';

describe('resolveDesktopBridge', () => {
  it('returns the bridge installed by the preload script', () => {
    const unused = (): Promise<never> => Promise.reject(new Error('unused'));
    const bridge = {
      getAppInfo: unused,
      openDocumentDialog: unused,
      getInitialDocument: unused,
    };

    expect(resolveDesktopBridge({ [DESKTOP_BRIDGE_KEY]: bridge })).toBe(bridge);
  });

  it.each([
    ['the scope is not an object', 'window'],
    ['the scope is null', null],
    ['the bridge is missing', {}],
    ['the bridge is not an object', { [DESKTOP_BRIDGE_KEY]: 'nope' }],
    ['the bridge lacks the expected operations', { [DESKTOP_BRIDGE_KEY]: {} }],
    [
      'the bridge lacks one of the expected operations',
      { [DESKTOP_BRIDGE_KEY]: { getAppInfo: (): void => undefined } },
    ],
  ])('returns null when %s', (_label, scope) => {
    expect(resolveDesktopBridge(scope)).toBeNull();
  });
});
