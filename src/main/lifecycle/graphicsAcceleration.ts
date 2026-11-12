import { basename } from 'node:path';

/**
 * Decides whether Lexleaf draws with the graphics card.
 *
 * Linux only. Chromium's graphics process loads the system's graphics
 * driver, and some drivers crash inside it. The one reported against
 * Lexleaf is Nouveau, the community driver for NVIDIA cards, on Ubuntu
 * 24.04 with Mesa 25.2: the graphics process died with a segmentation
 * fault inside Mesa's `libgallium`. A crash there is not just a flicker —
 * it is the helper crash that Ubuntu's crash reporter then "relaunches"
 * into the runaway process described in `orphanedZygotes.ts`.
 *
 * Lexleaf shows pages of a book. It does not need the graphics card to do
 * that, so on a machine whose display is driven by a driver known to
 * crash, it draws in software instead and never loads the driver at all.
 *
 * The reader can overrule the choice either way with `LEXLEAF_GPU=on` or
 * `LEXLEAF_GPU=off`.
 */

/** Kernel display drivers under which hardware acceleration is not used. */
export const UNRELIABLE_DISPLAY_DRIVERS: readonly string[] = ['nouveau'];

export interface DisplayDriverProbe {
  /** Names in `/sys/class/drm`. Throws or returns nothing where there is none. */
  listCards(): readonly string[];
  /** Target of `/sys/class/drm/<card>/device/driver`, or `null`. */
  driverLink(card: string): string | null;
}

export type AccelerationDecision =
  | { readonly accelerate: true; readonly reason: 'not-linux' | 'forced-on' | 'no-known-problem' }
  | {
      readonly accelerate: false;
      readonly reason: 'forced-off' | 'unreliable-driver';
      readonly driver: string | null;
    };

/** The kernel drivers behind this machine's display devices. */
export const displayDrivers = (probe: DisplayDriverProbe): string[] => {
  let cards: readonly string[];

  try {
    cards = probe.listCards();
  } catch {
    return [];
  }

  const drivers = new Set<string>();

  for (const card of cards) {
    // `card0`, `card1` — not the connectors (`card0-HDMI-A-1`) beside them.
    if (!/^card\d+$/u.test(card)) {
      continue;
    }

    try {
      const link = probe.driverLink(card);

      if (link !== null && link !== '') {
        drivers.add(basename(link).toLowerCase());
      }
    } catch {
      // A card that cannot be asked is a card nothing is known about.
    }
  }

  return [...drivers].sort();
};

export const decideAcceleration = ({
  platform,
  override,
  probe,
}: {
  readonly platform: string;
  /** The value of `LEXLEAF_GPU`, if set. */
  readonly override: string | undefined;
  readonly probe: DisplayDriverProbe;
}): AccelerationDecision => {
  const wish = override?.trim().toLowerCase();

  if (wish === 'off') {
    return { accelerate: false, reason: 'forced-off', driver: null };
  }

  if (wish === 'on') {
    return { accelerate: true, reason: 'forced-on' };
  }

  if (platform !== 'linux') {
    return { accelerate: true, reason: 'not-linux' };
  }

  const unreliable = displayDrivers(probe).find((driver) =>
    UNRELIABLE_DISPLAY_DRIVERS.includes(driver),
  );

  return unreliable === undefined
    ? { accelerate: true, reason: 'no-known-problem' }
    : { accelerate: false, reason: 'unreliable-driver', driver: unreliable };
};
