import { describe, expect, it } from 'vitest';

import { IpcChannel, isKnownIpcChannel } from './channels';

describe('IPC channels', () => {
  it('exposes only the channels approved for the current milestone', () => {
    expect(Object.values(IpcChannel)).toEqual([
      'app:get-info',
      'pdf:open-dialog',
      'pdf:initial-document',
      'pdf:open-recent',
      'state:get',
      'state:save-position',
      'state:forget',
      'state:save-preferences',
      'dictionary:look-up',
      'vocabulary:state-for-word',
      'vocabulary:save',
      'vocabulary:remove',
      'vocabulary:restore',
      'vocabulary:list',
      'vocabulary:search',
      'vocabulary:occurrences',
      'vocabulary:recovery-backups',
      'vocabulary:recovery-restore',
      'ai:status',
      'ai:explanation-for',
      'ai:explain',
      'ai:cancel',
      'update:check',
      'update:set-automatic',
      'update:open-download',
    ]);
  });

  it('has no channel that could execute, read or write something arbitrary', () => {
    for (const channel of Object.values(IpcChannel)) {
      expect(channel).not.toMatch(/execute|eval|read-file|write-file|query|sql/u);
    }
  });

  it('has no channel that could name an endpoint, a model or a credential', () => {
    for (const channel of Object.values(IpcChannel)) {
      expect(channel).not.toMatch(/url|endpoint|fetch|request|proxy|key|token|prompt|model/u);
    }
  });

  it('recognises a declared channel', () => {
    expect(isKnownIpcChannel(IpcChannel.GetAppInfo)).toBe(true);
  });

  it('rejects an undeclared channel', () => {
    expect(isKnownIpcChannel('app:execute')).toBe(false);
  });
});
