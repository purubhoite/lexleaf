/**
 * Refuses to run the suite while a mutation campaign owns the working tree.
 *
 * This is a Vitest `globalSetup`, so it runs once, in the main Vitest
 * process, *before* any test file is collected or executed — which is the
 * only useful moment: by the time a test imports a mutated module the damage
 * is done and the failure looks like a regression.
 *
 * Why it exists (`docs/M7_INVESTIGATION.md` §7 G1, §14.1, §14.8 G-c): a
 * session was spent hunting a synchronisation bug that did not exist,
 * because three "load-sensitive" failures were really three mutants planted
 * by a campaign running in another terminal. The campaign runner has guarded
 * itself against a second campaign since M7.4; nothing guarded an ordinary
 * `npm test`. This does.
 *
 * It is deliberately *not* "fail whenever the lock exists": the campaign runs
 * the suite itself, many times, while holding its own lock. See
 * `scripts/mutation/campaignLock.mjs` for how an authorised child of the
 * campaign is told apart from an unrelated process.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mutationCampaign = await import('../../scripts/mutation/campaignLock.mjs').catch(() => null);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const setup = () => {
  // Mutation tooling is intentionally omitted from the public snapshot.
  // Ordinary public tests remain runnable when it is unavailable.
  if (mutationCampaign === null) return;

  const {
    assessRecovery,
    campaignPaths,
    interlockDecision,
    isAuthorisedSubprocess,
    readLockFile,
    readMarkerFile,
    registerReader,
  } = mutationCampaign;
  const { lockFile, markerFile } = campaignPaths(projectRoot);
  const { record, exists } = readLockFile(lockFile);

  /*
   * Two questions, not one. "Is a campaign running right now?" is the lock's
   * to answer. "Did a campaign stop without putting the tree back?" is the
   * recovery state's — and until the D-1 remediation nothing asked it, so a
   * kill followed by `npm ci` left a mutated tree that this interlock waved
   * straight through and a suite that failed for reasons nobody could see.
   */
  const decision = interlockDecision({
    record,
    exists,
    env: process.env,
    pid: process.pid,
    lockFile,
    recovery: assessRecovery({ projectRoot }),
    marker: readMarkerFile(markerFile),
  });

  if (decision.allowed) {
    /*
     * Being admitted is not enough. Until now this was a one-time check, so
     * a campaign that started *after* this point rewrote production source
     * underneath a suite that was already executing — measured by the third
     * audit as 52,120 of 110,402 reads of one source file returning mutated
     * or mid-rename content (finding B-2). An admitted suite therefore
     * registers itself for its whole lifetime, and a campaign refuses to
     * start while any registration is live.
     *
     * The campaign's own subprocesses are exempt: they run *because* a
     * campaign holds the lock, and registering them would deadlock it.
     */
    if (isAuthorisedSubprocess({ record, env: process.env })) {
      return;
    }

    const deregister = registerReader({ projectRoot });

    /*
     * The second half of the handshake. A campaign takes the lock and then
     * looks for readers; a suite registers and then looks at the lock. If
     * the two interleaved, each sees the other and backs off, which is the
     * safe direction to fail.
     */
    const after = readLockFile(lockFile);
    const recheck = interlockDecision({
      record: after.record,
      exists: after.exists,
      env: process.env,
      pid: process.pid,
      lockFile,
      recovery: assessRecovery({ projectRoot }),
      marker: readMarkerFile(markerFile),
    });

    if (!recheck.allowed) {
      deregister();

      throw new Error(
        '\n\nMUTATION CAMPAIGN IN PROGRESS — the suite was not started.\n\n' +
          `${recheck.message}\n`,
      );
    }

    return deregister;
  }

  // Thrown rather than `process.exit`: Vitest reports it as a setup error,
  // with the message, and still tears its workers down cleanly.
  const headline =
    decision.reason === 'recovery-required' || decision.reason === 'recovery-inconsistent'
      ? 'MUTATION RECOVERY OUTSTANDING — the suite was not started.'
      : 'MUTATION CAMPAIGN IN PROGRESS — the suite was not started.';

  throw new Error(`\n\n${headline}\n\n${decision.message}\n`);
};
