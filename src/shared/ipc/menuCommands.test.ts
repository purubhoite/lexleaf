import { describe, expect, it } from 'vitest';

import {
  MENU_COMMANDS,
  MENU_COMMAND_KEYS,
  keyboardCommand,
  parseMenuCommand,
  type KeyPress,
} from './menuCommands';

const press = (key: string, modifiers: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe('menu commands', () => {
  it('accepts its own names and nothing else', () => {
    for (const command of MENU_COMMANDS) {
      expect(parseMenuCommand(command)).toBe(command);
    }

    for (const raw of ['open', 'OPEN-DOCUMENT', '', null, 4, { command: 'find' }, '/etc/passwd']) {
      expect(parseMenuCommand(raw)).toBeNull();
    }
  });

  it('shows a key only for commands that exist', () => {
    for (const command of Object.keys(MENU_COMMAND_KEYS)) {
      expect(MENU_COMMANDS).toContain(command);
    }
  });
});

describe('the keyboard', () => {
  it('asks for the commands the menu advertises', () => {
    expect(keyboardCommand(press('o', { ctrlKey: true }))).toBe('open-document');
    expect(keyboardCommand(press('O', { metaKey: true }))).toBe('open-document');
    expect(keyboardCommand(press('w', { ctrlKey: true }))).toBe('close-document');
    expect(keyboardCommand(press('g', { ctrlKey: true }))).toBe('go-to-page');
    expect(keyboardCommand(press('l', { ctrlKey: true }))).toBe('toggle-saved-words');
    expect(keyboardCommand(press(',', { ctrlKey: true }))).toBe('toggle-settings');
    expect(keyboardCommand(press('O', { ctrlKey: true, shiftKey: true }))).toBe('toggle-contents');
    expect(keyboardCommand(press('F11'))).toBe('toggle-reading-mode');
  });

  it('leaves ordinary typing and the reader’s own keys alone', () => {
    for (const plain of ['o', 'w', 'g', 'l', ',', 'Enter', 'Escape']) {
      expect(keyboardCommand(press(plain))).toBeNull();
    }

    // Zoom and find belong to the reader.
    for (const key of ['f', '+', '=', '-', '0']) {
      expect(keyboardCommand(press(key, { ctrlKey: true }))).toBeNull();
    }

    // Alt with the arrows walks words; AltGr combinations type characters.
    expect(keyboardCommand(press('o', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(keyboardCommand(press('w', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keyboardCommand(press('F11', { ctrlKey: true }))).toBeNull();
  });
});
