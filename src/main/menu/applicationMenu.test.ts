import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { MENU_COMMANDS, type MenuCommand } from '@shared/ipc/menuCommands';

import { buildApplicationMenu } from './applicationMenu';

const flatten = (items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((item) =>
    Array.isArray(item.submenu) ? [item, ...flatten(item.submenu)] : [item],
  );

const build = (development = false) => {
  const send = vi.fn<(command: MenuCommand) => void>();
  const reportProblem = vi.fn();
  const menu = buildApplicationMenu({ send, reportProblem, development });

  return { send, reportProblem, menu, items: flatten(menu) };
};

const click = (item: MenuItemConstructorOptions | undefined): void => {
  (item?.click as (() => void) | undefined)?.();
};

describe('the application menu', () => {
  it('has Lexleaf’s menus, in order', () => {
    expect(build().menu.map((item) => item.label)).toStrictEqual([
      '&File',
      '&Edit',
      '&View',
      '&Go',
      '&Help',
    ]);
  });

  it('offers every command the window understands, exactly once', () => {
    const { items, send } = build();

    for (const item of items) {
      if (item.role === undefined && item.submenu === undefined) {
        click(item);
      }
    }

    expect(send.mock.calls.map(([command]) => command).sort()).toStrictEqual(
      [...MENU_COMMANDS].sort(),
    );
  });

  it('shows keys without registering them, so the window decides what a key does', () => {
    const withKeys = build().items.filter((item) => item.accelerator !== undefined);

    expect(withKeys.length).toBeGreaterThan(5);

    for (const item of withKeys) {
      expect(item.registerAccelerator).toBe(false);
    }
  });

  it('reports a problem from the Help menu without going through the window', () => {
    const { items, reportProblem, send } = build();

    click(items.find((item) => item.label === 'Report a Problem…'));

    expect(reportProblem).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('has no reload and no developer tools in a released build', () => {
    const roles = build().items.map((item) => item.role);

    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('forceReload');
    expect(roles).not.toContain('toggleDevTools');
    expect(build(true).items.map((item) => item.role)).toContain('toggleDevTools');
  });

  it('leads nowhere but Lexleaf', () => {
    expect(JSON.stringify(build().menu).toLowerCase()).not.toContain('electron');
  });
});
