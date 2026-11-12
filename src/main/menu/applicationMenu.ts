import type { MenuItemConstructorOptions } from 'electron';

import { MENU_COMMAND_KEYS, type MenuCommand } from '@shared/ipc/menuCommands';

/**
 * Lexleaf's own menu bar.
 *
 * Without one, Electron supplies a stock menu: Reload, developer tools and
 * a Help menu that leads to Electron's website — none of which is Lexleaf.
 * This is the menu of a reading application: what it can open, where it
 * can go in a book, how the page is shown, and the saved words.
 *
 * Almost every item does what a button in the window does, by sending the
 * window that command's name. The keys beside the items are shown, not
 * registered here: the window listens for them itself (`keyboardCommand`),
 * so a key means the same thing whether or not a menu bar is showing.
 */

export interface ApplicationMenuOptions {
  /** Sends a command to the window. */
  readonly send: (command: MenuCommand) => void;
  /** Opens the prefilled problem report in the browser. */
  readonly reportProblem: () => void;
  /** Adds Reload and the developer tools. Never in a released build. */
  readonly development: boolean;
}

export const buildApplicationMenu = ({
  send,
  reportProblem,
  development,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] => {
  const command = (label: string, name: MenuCommand): MenuItemConstructorOptions => {
    const key = MENU_COMMAND_KEYS[name];

    return {
      label,
      click: (): void => {
        send(name);
      },
      ...(key === undefined ? {} : { accelerator: key, registerAccelerator: false }),
    };
  };

  const separator: MenuItemConstructorOptions = { type: 'separator' };

  return [
    {
      label: '&File',
      submenu: [
        command('Open PDF…', 'open-document'),
        command('Close PDF', 'close-document'),
        separator,
        command('Print…', 'print'),
        separator,
        {
          label: 'Export Saved Words',
          submenu: [
            command('Spreadsheet (CSV)…', 'export-csv'),
            command('Anki Flashcards…', 'export-anki'),
          ],
        },
        separator,
        command('Settings', 'toggle-settings'),
        separator,
        { role: 'quit', label: 'Quit Lexleaf' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
        separator,
        command('Find in Document…', 'find'),
        separator,
        command('Bookmark This Page', 'toggle-bookmark'),
        command('Read Selection Aloud', 'read-aloud'),
      ],
    },
    {
      label: '&View',
      submenu: [
        command('Zoom In', 'zoom-in'),
        command('Zoom Out', 'zoom-out'),
        command('Fit Width', 'zoom-fit-width'),
        command('Fit Page', 'zoom-fit-page'),
        separator,
        command('Scrolling', 'view-continuous'),
        command('One Page', 'view-single'),
        command('Two Pages', 'view-two'),
        separator,
        command('Rotate Right', 'rotate-right'),
        command('Rotate Left', 'rotate-left'),
        separator,
        command('Reading Mode', 'toggle-reading-mode'),
        ...(development
          ? [separator, { role: 'reload' } as const, { role: 'toggleDevTools' } as const]
          : []),
      ],
    },
    {
      label: '&Go',
      submenu: [
        command('Back', 'go-back'),
        separator,
        command('Contents', 'toggle-contents'),
        command('Pages', 'toggle-thumbnails'),
        command('Bookmarks', 'toggle-bookmarks'),
        command('Highlights and Notes', 'toggle-notes'),
        command('Go to Page…', 'go-to-page'),
        separator,
        command('Saved Words', 'toggle-saved-words'),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Report a Problem…',
          click: (): void => {
            reportProblem();
          },
        },
        separator,
        command('About Lexleaf', 'about'),
      ],
    },
  ];
};
