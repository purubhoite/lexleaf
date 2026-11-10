import { useEffect, useState, type ReactElement } from 'react';
import type { DesktopBridge } from '@shared/ipc/contracts';

export const VocabularyRecoveryPanel = ({
  bridge,
}: {
  readonly bridge: DesktopBridge;
}): ReactElement | null => {
  const recovery = bridge.recovery;
  const [state, setState] = useState<{
    status: 'loading' | 'hidden' | 'ready' | 'confirm' | 'busy' | 'done' | 'failed';
    backups: readonly {
      backupId: string;
      createdAt: string;
      schemaVersion: number;
      databaseSize: number;
    }[];
    selected: string | null;
  }>({ status: 'loading', backups: [], selected: null });
  useEffect(() => {
    let active = true;
    if (recovery === undefined) return;
    void recovery.listBackups().then((reply) => {
      if (!active) return;
      if (!reply.ok) {
        setState((old) => ({ ...old, status: 'failed' }));
        return;
      }
      setState({
        status: reply.recoveryRequired ? 'ready' : 'hidden',
        backups: reply.backups,
        selected: null,
      });
    });
    return () => {
      active = false;
    };
  }, [recovery]);
  if (recovery === undefined || state.status === 'loading' || state.status === 'hidden')
    return null;
  const selected = state.backups.find((backup) => backup.backupId === state.selected) ?? null;
  const restore = async (): Promise<void> => {
    if (selected === null || state.status !== 'confirm') return;
    setState((old) => ({ ...old, status: 'busy' }));
    const result = await recovery.restore(selected.backupId, selected.backupId);
    setState((old) => ({ ...old, status: result.ok ? 'done' : 'failed' }));
  };
  return (
    <section aria-labelledby="vocabulary-recovery-title" data-testid="vocabulary-recovery">
      <h2 id="vocabulary-recovery-title">Vocabulary recovery required</h2>
      <p>
        Your vocabulary database needs recovery. Reading and dictionary features remain available.
      </p>
      {state.backups.length === 0 ? (
        <p data-testid="recovery-empty">No verified backup is available.</p>
      ) : (
        <>
          <label>
            Verified backup
            <select
              aria-label="Verified vocabulary backup"
              value={state.selected ?? ''}
              onChange={(event) =>
                setState((old) => ({
                  ...old,
                  selected: event.target.value || null,
                  status: event.target.value ? 'confirm' : 'ready',
                }))
              }
            >
              <option value="">Select a backup</option>
              {state.backups.map((backup) => (
                <option key={backup.backupId} value={backup.backupId}>
                  {new Date(backup.createdAt).toLocaleString()} — schema {backup.schemaVersion} —{' '}
                  {backup.databaseSize} bytes
                </option>
              ))}
            </select>
          </label>
          {state.status === 'confirm' && selected !== null && (
            <div role="dialog">
              <p>
                This will replace the current vocabulary database with backup {selected.backupId}.
                This cannot be undone automatically.
              </p>
              <button
                type="button"
                onClick={() => setState((old) => ({ ...old, status: 'ready' }))}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void restore()}>
                Confirm restore of {selected.backupId}
              </button>
            </div>
          )}
          {state.status === 'busy' && <p role="status">Restoration in progress…</p>}
          {state.status === 'done' && (
            <p role="status">Vocabulary restoration completed successfully.</p>
          )}
          {state.status === 'failed' && (
            <p role="alert">
              Restoration was not completed. Your existing files and verified backups were
              preserved.
            </p>
          )}
        </>
      )}
    </section>
  );
};
