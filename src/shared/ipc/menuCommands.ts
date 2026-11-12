/**
 * The things the application menu and the keyboard can ask the window to do.
 *
 * A command is a name and nothing else. The menu lives in the main
 * process and the screens live in the renderer, so a menu item sends its
 * name across and the renderer does what its own button would have done.
 * Nothing in a command says where a file is or what to open; the commands
 * that open something lead to the same dialogs their buttons lead to.
 */
export const MENU_COMMANDS = [
  'open-document',
  'close-document',
  'find',
  'go-to-page',
  'toggle-contents',
  'zoom-in',
  'zoom-out',
  'zoom-fit-width',
  'zoom-fit-page',
  'toggle-saved-words',
  'export-csv',
  'export-anki',
  'toggle-settings',
  'toggle-reading-mode',
  'about',
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const parseMenuCommand = (raw: unknown): MenuCommand | null =>
  MENU_COMMANDS.find((command) => command === raw) ?? null;

/**
 * The key that asks for each command, as the menu shows it.
 *
 * `CmdOrCtrl` is the menu's own spelling. The keys are listened for in the
 * window (see `keyboardCommand`), not registered by the menu, so that one
 * piece of code decides what a key does whether or not a menu is showing.
 */
export const MENU_COMMAND_KEYS: Readonly<Partial<Record<MenuCommand, string>>> = {
  'open-document': 'CmdOrCtrl+O',
  'close-document': 'CmdOrCtrl+W',
  find: 'CmdOrCtrl+F',
  'go-to-page': 'CmdOrCtrl+G',
  'toggle-contents': 'CmdOrCtrl+Shift+O',
  'zoom-in': 'CmdOrCtrl+Plus',
  'zoom-out': 'CmdOrCtrl+-',
  'zoom-fit-width': 'CmdOrCtrl+0',
  'toggle-saved-words': 'CmdOrCtrl+L',
  'toggle-settings': 'CmdOrCtrl+,',
  'toggle-reading-mode': 'F11',
};

/** The part of a key press that decides which command it is. */
export interface KeyPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * The command a key press asks for, or `null`.
 *
 * Zoom and find are not here: the reader has answered those keys itself
 * since it had a toolbar, and two listeners for one key would zoom twice.
 */
export const keyboardCommand = (press: KeyPress): MenuCommand | null => {
  if (press.key === 'F11' && !press.ctrlKey && !press.metaKey && !press.altKey) {
    return 'toggle-reading-mode';
  }

  if (!(press.ctrlKey || press.metaKey) || press.altKey) {
    return null;
  }

  const key = press.key.toLowerCase();

  if (press.shiftKey) {
    return key === 'o' ? 'toggle-contents' : null;
  }

  switch (key) {
    case 'o':
      return 'open-document';
    case 'w':
      return 'close-document';
    case 'g':
      return 'go-to-page';
    case 'l':
      return 'toggle-saved-words';
    case ',':
      return 'toggle-settings';
    default:
      return null;
  }
};
