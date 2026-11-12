import type { MenuCommand } from '@shared/ipc/menuCommands';

/**
 * How a command reaches the part of the window that carries it out.
 *
 * A command can come from the application menu or from the keyboard, and
 * the thing that answers it may be the shell (saved words, settings) or
 * the reader (open, find, zoom). Both listen here; each ignores what is
 * not its own.
 */
export interface CommandSource {
  subscribe(listener: (command: MenuCommand) => void): () => void;
}

export interface CommandBus extends CommandSource {
  dispatch(command: MenuCommand): void;
}

export const createCommandBus = (): CommandBus => {
  const listeners = new Set<(command: MenuCommand) => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);

      return (): void => {
        listeners.delete(listener);
      };
    },
    dispatch: (command) => {
      for (const listener of [...listeners]) {
        listener(command);
      }
    },
  };
};
