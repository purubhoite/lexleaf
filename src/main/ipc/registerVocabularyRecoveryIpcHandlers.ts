import { IpcChannel } from '@shared/ipc/channels';
import {
  parseVocabularyRecoveryRestoreRequest,
  type VocabularyRecoveryListResult,
  type VocabularyRecoveryRestoreResult,
} from '@shared/ipc/vocabularyContracts';
import type { VocabularyBackupCoordinator } from '../vocabulary/vocabularyBackupCoordinator';
import type { RestoreCoordinator } from '../vocabulary/vocabularyRestoreCoordinator';
import type { VocabularyMaintenanceGate } from '../vocabulary/vocabularyMaintenanceGate';
import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export interface VocabularyRecoveryIpcOptions {
  readonly backups: VocabularyBackupCoordinator;
  readonly restore: RestoreCoordinator;
  readonly recoveryPermitted: () => boolean;
  readonly gate?: VocabularyMaintenanceGate;
  readonly onRestoreStart?: () => Promise<void>;
  readonly onRestoreComplete?: (backupId: string) => Promise<void>;
  readonly onRejected: (message: string) => void;
  readonly devServerOrigin: string | null;
}

export const registerVocabularyRecoveryIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  {
    backups,
    restore,
    recoveryPermitted,
    gate,
    onRestoreStart,
    onRestoreComplete,
    onRejected,
    devServerOrigin,
  }: VocabularyRecoveryIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);
  let inFlight = false;

  ipc.handle(
    IpcChannel.VocabularyRecoveryBackups,
    guard(IpcChannel.VocabularyRecoveryBackups, async (): Promise<VocabularyRecoveryListResult> => {
      const inventory = await backups.inventory();
      return {
        ok: true,
        recoveryRequired: recoveryPermitted(),
        backups: inventory
          .filter((item) => item.status === 'valid-published' && item.manifest !== undefined)
          .map((item) => ({
            backupId: item.manifest!.backupId,
            createdAt: item.manifest!.createdAt,
            schemaVersion: item.manifest!.schemaVersion,
            databaseSize: item.manifest!.databaseSize,
          })),
      };
    }),
  );

  ipc.handle(
    IpcChannel.VocabularyRecoveryRestore,
    guard(
      IpcChannel.VocabularyRecoveryRestore,
      async (raw: unknown): Promise<VocabularyRecoveryRestoreResult> => {
        const request = parseVocabularyRecoveryRestoreRequest(raw);
        if (request === null) {
          onRejected('a malformed vocabulary restore request was ignored');
          return { ok: false, error: 'invalid-request' };
        }
        if (!recoveryPermitted()) return { ok: false, error: 'recovery-required' };
        if (inFlight) return { ok: false, error: 'busy' };
        if (gate !== undefined && !gate.beginRestore()) return { ok: false, error: 'busy' };
        inFlight = true;
        let succeeded = false;
        try {
          await onRestoreStart?.();
          const result = await restore.restore(request.backupId, request.confirmedBackupId);
          await onRestoreComplete?.(result.backupId);
          succeeded = true;
          return { ok: true, backupId: result.backupId };
        } catch (error) {
          const code =
            error instanceof Error && 'code' in error
              ? String((error as { code?: unknown }).code)
              : '';
          if (code === 'not-authorized') return { ok: false, error: 'not-authorized' };
          if (code === 'invalid-backup') return { ok: false, error: 'unknown-backup' };
          if (code === 'live-busy') return { ok: false, error: 'busy' };
          onRejected('the vocabulary restore failed without exposing database details');
          return { ok: false, error: 'blocked' };
        } finally {
          inFlight = false;
          gate?.finishRestore(succeeded);
        }
      },
    ),
  );
};
