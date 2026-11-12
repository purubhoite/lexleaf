import { describe, expect, it } from 'vitest';

import {
  decideAcceleration,
  displayDrivers,
  type DisplayDriverProbe,
} from './graphicsAcceleration';

/** A machine described by which driver sits behind each card. */
const machine = (cards: Record<string, string | null>): DisplayDriverProbe => ({
  listCards: () => Object.keys(cards),
  driverLink: (card) => cards[card] ?? null,
});

const NOUVEAU = '../../../../bus/pci/drivers/nouveau';
const INTEL = '../../../bus/pci/drivers/i915';

describe('finding the display drivers', () => {
  it('reads the driver behind each card and ignores the connectors', () => {
    expect(
      displayDrivers(
        machine({
          card0: INTEL,
          'card0-HDMI-A-1': NOUVEAU,
          card1: NOUVEAU,
          version: null,
          renderD128: NOUVEAU,
        }),
      ),
    ).toStrictEqual(['i915', 'nouveau']);
  });

  it('finds nothing where nothing can be read', () => {
    expect(
      displayDrivers({
        listCards: () => {
          throw new Error('ENOENT');
        },
        driverLink: () => null,
      }),
    ).toStrictEqual([]);
    expect(
      displayDrivers({
        listCards: () => ['card0'],
        driverLink: () => {
          throw new Error('EACCES');
        },
      }),
    ).toStrictEqual([]);
    expect(displayDrivers(machine({ card0: null }))).toStrictEqual([]);
  });
});

describe('deciding whether to use the graphics card', () => {
  it('draws in software under Nouveau', () => {
    expect(
      decideAcceleration({
        platform: 'linux',
        override: undefined,
        probe: machine({ card1: NOUVEAU }),
      }),
    ).toStrictEqual({ accelerate: false, reason: 'unreliable-driver', driver: 'nouveau' });
  });

  it('draws in software when any card is on Nouveau', () => {
    expect(
      decideAcceleration({
        platform: 'linux',
        override: undefined,
        probe: machine({ card0: INTEL, card1: NOUVEAU }),
      }).accelerate,
    ).toBe(false);
  });

  it('leaves every other Linux machine as it was', () => {
    for (const driver of [
      INTEL,
      '../drivers/amdgpu',
      '../drivers/nvidia',
      '../drivers/virtio-pci',
    ]) {
      expect(
        decideAcceleration({
          platform: 'linux',
          override: undefined,
          probe: machine({ card0: driver }),
        }),
      ).toStrictEqual({ accelerate: true, reason: 'no-known-problem' });
    }

    expect(
      decideAcceleration({ platform: 'linux', override: undefined, probe: machine({}) }).accelerate,
    ).toBe(true);
  });

  it('does not look at all on Windows or macOS', () => {
    const probe: DisplayDriverProbe = {
      listCards: () => {
        throw new Error('must not be asked');
      },
      driverLink: () => NOUVEAU,
    };

    expect(decideAcceleration({ platform: 'win32', override: undefined, probe })).toStrictEqual({
      accelerate: true,
      reason: 'not-linux',
    });
    expect(decideAcceleration({ platform: 'darwin', override: '', probe }).accelerate).toBe(true);
  });

  it('lets the reader overrule it in either direction', () => {
    expect(
      decideAcceleration({
        platform: 'linux',
        override: ' ON ',
        probe: machine({ card0: NOUVEAU }),
      }),
    ).toStrictEqual({ accelerate: true, reason: 'forced-on' });
    expect(
      decideAcceleration({ platform: 'win32', override: 'off', probe: machine({}) }),
    ).toStrictEqual({ accelerate: false, reason: 'forced-off', driver: null });
    // Anything else is not an instruction.
    expect(
      decideAcceleration({
        platform: 'linux',
        override: 'maybe',
        probe: machine({ card0: NOUVEAU }),
      }).accelerate,
    ).toBe(false);
  });
});
