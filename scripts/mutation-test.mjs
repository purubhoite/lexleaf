#!/usr/bin/env node
/**
 * Mutation harness for the state, message and feedback work (M6.5).
 *
 * A test suite that grows is not evidence that it got harder to break.
 * This script plants a known fault in production source, runs the tests
 * that are supposed to notice, records which ones actually failed, and
 * puts the file back. A mutant that survives is a gap in the tests, not a
 * gap in the product.
 *
 * It lives in the repository because the 6.5 acceptance audit found the
 * previous harness kept under `/var/tmp`, which no longer existed by the
 * time the audit ran (condition C5). Nothing here is part of the
 * application: no bundle imports it, it adds no dependency, and it uses
 * only Node and the Vitest that already runs the suite.
 *
 * Usage:
 *   node scripts/mutation-test.mjs             every mutant
 *   node scripts/mutation-test.mjs --list      the catalogue, run nothing
 *   node scripts/mutation-test.mjs --only C1-js-boundary[,…]
 *   node scripts/mutation-test.mjs --recover   finish an interrupted
 *                                              campaign and stop
 *   node scripts/mutation-test.mjs --force     take over a lock whose owner
 *                                              is gone, or one whose owner
 *                                              cannot be identified on this
 *                                              platform. A *live* owner is
 *                                              never taken over (M7.4 G-e)
 *   node scripts/mutation-test.mjs --clear-recovery-state
 *                                              clear an interrupted
 *                                              campaign's state once the
 *                                              files it recorded are back to
 *                                              their originals. Refuses while
 *                                              any of them is not (§14.11)
 *
 *   node scripts/mutation-test.mjs --force     take over a lock whose owner
 *                                              is provably gone. Never
 *                                              overrides a live owner, and
 *                                              never overrides an owner that
 *                                              cannot be identified
 *
 * The lock, the interrupted-campaign marker, the journal and the original
 * bytes of every file a campaign is holding live in `.mutation-state/` in the
 * repository root — deliberately not under `node_modules`, which `npm ci`
 * deletes (the slice 1 audit, defect D-1).
 *
 * The limits of that, because they are easy to misread (re-audit R-4):
 * `.mutation-state/` is ignored by Git, so `git clean -fdX` and `git clean
 * -fdx` delete it outright, along with the journal, the original bytes and
 * every trace that a campaign was interrupted. Surviving `npm ci` is a
 * deliberate property of where this state lives; surviving explicit deletion
 * of ignored files is not possible, and no amount of care here can make it
 * so. Once that state is gone this script cannot detect an interrupted
 * campaign and cannot recover one: "no recovery state found" is a statement
 * about four files in one directory and never a statement that the working
 * tree is clean. The recovery of last resort is version control — compare
 * `src/` against a trusted baseline (`git status --short -- src`, `git diff`)
 * and restore from it.
 *
 * Exit status is 0 only when the unmutated control passes and every
 * mutant is killed. Kills are judged from Vitest's JSON report — the
 * count of failed assertions and their names — never from an exit code,
 * which cannot tell a failing test from a crashed runner.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORISATION_ENV,
  acquireClaim,
  assessRecovery,
  campaignPaths,
  liveReaders,
  readMarkerFile,
  resolveOwnership,
  clearJournal,
  clearMarker,
  fileMode,
  mintAuthorisation,
  ownerIdentity,
  readLockFile,
  recoverJournal,
  sweepTemporaries,
  writeFileDurably,
  writeJournal,
  writeMarker,
} from './mutation/campaignLock.mjs';

/*
 * Resolved from this file's own location, never from the working directory,
 * so a campaign started from a subdirectory and a campaign started from the
 * root agree about where the recovery state lives — and so a disposable
 * copy of the repository uses its own copy's state, even when its
 * dependencies are shared with the original (audit D-4).
 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * While this script runs, the working tree is not the working tree
 * ------------------------------------------------------------------ */

/**
 * The hazard this section exists for.
 *
 * A campaign plants faults in *real production files* and takes them out
 * again a few seconds later. For those seconds the checkout on disk is
 * not the checkout in Git, and anything else that reads those files —
 * another campaign, a `npm test` in a second terminal, a watcher, an
 * editor's type server — sees the fault and reports it as its own.
 *
 * That is not hypothetical. The M7 investigation recorded three
 * "load-sensitive" test failures and spent a session hunting a
 * synchronisation bug that does not exist: every one of the three
 * matched a mutant in this catalogue exactly, and every one came from a
 * suite that happened to overlap a campaign. The tests were never flaky.
 * The harness was unguarded.
 *
 * Three guards, none of which changes what a campaign measures:
 *
 * - an advisory lock, so a second campaign refuses to start rather than
 *   interleaving its edits with the first one's;
 * - a restore on SIGINT, SIGTERM, SIGHUP and on exit, so interrupting a
 *   campaign leaves the tree as it found it rather than mutated;
 * - a banner, so whoever is watching knows the tree is mutated and why
 *   their other terminal is lying to them.
 */

const {
  lockFile: LOCK_FILE,
  journalFile: JOURNAL_FILE,
  markerFile: MARKER_FILE,
  claimFile: CLAIM_FILE,
  stateDirectory: STATE_DIRECTORY,
} = campaignPaths(projectRoot);
const forced = process.argv.includes('--force');
const recoverOnly = process.argv.includes('--recover');
const clearStateOnly = process.argv.includes('--clear-recovery-state');

/** The secret handed to this campaign's own test subprocesses, and nothing else. */
const authorisation = mintAuthorisation();

const readLock = () => readLockFile(LOCK_FILE);

let holdsLock = false;

/**
 * The exact bytes this campaign wrote into the lock file.
 *
 * A campaign holds the short-lived claim only while it takes the lock over;
 * for the rest of the run the lock record *is* its authority. Keeping the
 * bytes lets the campaign ask the same question the claim answers — "is the
 * thing on disk still mine?" — before each destructive step, rather than
 * trusting that an acquisition which succeeded minutes ago still holds
 * (audit #5, F-3).
 */
let lockRecordBytes = null;

/**
 * Whether the lock on disk is still, byte for byte, the one this campaign
 * wrote. A different record means another campaign took the state over; an
 * absent file means something removed it. Neither is a state in which this
 * process may keep rewriting production source.
 */
const holdsCampaignLock = () => {
  if (!holdsLock || lockRecordBytes === null) {
    return false;
  }

  try {
    return readFileSync(LOCK_FILE).equals(lockRecordBytes);
  } catch {
    return false;
  }
};

/**
 * Finishes an interrupted campaign before anything else happens.
 *
 * SIGKILL cannot be intercepted, so the exit and signal handlers below are
 * not enough on their own: a campaign killed with it leaves a mutant in the
 * tree. Every mutation is journalled before the file is touched, so the
 * damage is always recoverable — and recovery has to happen *before* the
 * control run, or the control would be measured against a mutated tree and
 * would simply report "control is not green" (M7.4 G-d).
 */
/**
 * Who owns the campaign state, decided before anything is read for writing.
 *
 * Every path that can destroy ownership evidence — recovery, finalisation,
 * the escape hatch, lock takeover — goes through this first. The re-audit
 * (R-1) reproduced a live campaign losing its marker, journal and lock to a
 * second process simply because its lock file had been corrupted: a
 * malformed lock fell through the `live` guard into the clearing code. An
 * unreadable lock now makes ownership *less* certain, and the marker, which
 * is written independently of the lock, is consulted before any conclusion.
 */
const ownership = () =>
  resolveOwnership({
    lock: readLock(),
    marker: readMarkerFile(MARKER_FILE),
    pid: process.pid,
  });

/**
 * The refusal shared by every caller. Returns `true` when the caller may
 * proceed to touch state; exits the process when it may not.
 */
const requireUnowned = (action) => {
  const owner = ownership();

  if (owner.state === 'none' || owner.state === 'stale' || owner.state === 'self') {
    return owner;
  }

  if (owner.state === 'live') {
    console.error(
      `another mutation campaign is running (pid ${String(owner.pid)}; ${owner.evidence},\n` +
        `from the ${owner.source}). Its process is alive and owns this state: this is\n` +
        'a live lock, not a stale one.\n\n' +
        `${action} would fight it for the same files, so nothing has\n` +
        'been changed — no lock, no marker, no journal and no source file.\n' +
        (forced ? '--force does not override a live campaign. Stop that process first.\n' : '') +
        `Wait for it to finish (state: ${STATE_DIRECTORY}).`,
    );
    process.exit(1);
  }

  /*
   * Indeterminate. Not "probably fine": the evidence does not establish
   * whether a campaign is writing to these files right now, and --force
   * does not override it (the re-audit's finding on uncertain ownership).
   * The way out is to make the ownership determinate — stop the process,
   * or let it finish — not to assert that it is safe.
   */
  console.error(
    `the mutation campaign state has an owner this build cannot resolve: ${owner.evidence}` +
      `${owner.pid === null ? '' : ` (pid ${String(owner.pid)})`}, from the ${String(owner.source)}.\n\n` +
      `${action} could destroy the state of a campaign that is still running, or\n` +
      'overwrite files it is holding, so nothing has been changed.\n\n' +
      'To resolve it:\n' +
      (owner.pid === null
        ? `  · inspect ${STATE_DIRECTORY}/ and the working tree (\`git status --short -- src\`);\n` +
          `  · restore anything a campaign left behind, then remove ${STATE_DIRECTORY}/ by hand.\n`
        : `  · check what that process is (\`ps -fp ${String(owner.pid)}\`);\n` +
          '  · if it is a campaign, wait for it or stop it — once it is gone this\n' +
          '    resolves by itself and the interrupted work is recovered normally;\n' +
          `  · if it is unrelated and this build still cannot tell (no /proc), inspect\n` +
          `    the tree against version control and remove ${STATE_DIRECTORY}/ by hand.\n`) +
      '--force does not override uncertain ownership.',
  );
  process.exit(1);

  return owner;
};

/**
 * Takes the exclusive claim, or stops. Ownership says who *owns* the state;
 * the claim is what makes this process the only one acting on it, and it is
 * held until `release()` — across restoration and cleanup both (audit B-1).
 */
/**
 * Stops the process because it is no longer the owner of the state it is
 * working on (audit #5, F-3).
 *
 * The exclusive claim establishes who may act at the moment it is taken,
 * and nothing more: between that moment and any later write the holder can
 * cease to be authoritative — its claim swept by a contender, or its
 * process paused long enough to be judged dead and superseded. Acting on
 * that stale authority is how two processes end up restoring the same
 * transaction.
 *
 * The response is always the same shape, and it is deliberately *inert*:
 * nothing is written, nothing is deleted, and the journal and marker are
 * left exactly as they are so that whoever does hold the state can finish
 * the transaction from them. This is the one case where leaving a mutant
 * on disk is correct — the evidence to undo it is complete, and the
 * process that owns that evidence is still running.
 */
const stopBecauseAuthorityLost = (what) => {
  console.error(
    `\nstopping: this process no longer holds the exclusive claim on the mutation\n` +
      `state, and so may not continue ${what}.\n\n` +
      'Another process has taken the state over. Continuing would mean two processes\n' +
      'writing the same source files, so nothing further has been changed here.\n' +
      'The recovery journal and marker have been left in place: they are what the\n' +
      'current owner needs to finish or undo the transaction.\n\n' +
      'If no campaign is running, settle the state with\n' +
      '`node scripts/mutation-test.mjs --recover`.',
  );

  process.exit(1);
};

/**
 * Re-asserts this process's claim immediately before a destructive step.
 *
 * The check and the operation that follows it are two system calls, so
 * this narrows the window rather than closing it: the claim can still be
 * lost in between. It is not a substitute for the acquisition protocol —
 * it is what keeps a *stale* owner, one that lost authority seconds or
 * minutes ago, from writing at all. See §14.15 of the investigation for
 * the residual window.
 */
const requireStillClaimed = (claim, what) => {
  if (!claim.holdsClaim()) {
    stopBecauseAuthorityLost(what);
  }
};

const requireClaim = (purpose) => {
  const claim = acquireClaim({ projectRoot, purpose });

  if (claim.ok) {
    // However this process ends — normally, by `process.exit`, or on an
    // uncaught throw — the claim must not outlive it, or the next run
    // would have to steal it.
    process.on('exit', claim.release);

    return claim;
  }

  if (claim.reason === 'held') {
    console.error(
      `another process is already working on this mutation state (pid ${String(claim.holder)},` +
        ` ${String(claim.purpose)}).\n` +
        'Two processes restoring or clearing the same transaction at once can leave it\n' +
        'half-recovered, so nothing has been changed. Wait for it to finish and try again.',
    );
  } else if (claim.reason === 'unreadable') {
    /*
     * Name the generation that is actually unreadable. Claims are
     * generation numbered, so the offending file is often
     * `campaign.claim.gN` rather than `campaign.claim`, and telling an
     * operator to delete the latter points them at the wrong file —
     * possibly at a perfectly valid claim belonging to a live process.
     */
    console.error(
      `there is a claim on this mutation state that cannot be read (${String(
        claim.path ?? CLAIM_FILE,
      )}).\n` +
        'It is not safe to assume nobody is working on the state, and it is not safe to\n' +
        'delete a claim this build does not understand, so nothing has been changed.\n' +
        'Check for a running campaign or recovery, then remove that file by hand.',
    );
  } else {
    console.error(
      'could not take an exclusive claim on the mutation state: it is being contended\n' +
        'by other processes. Nothing has been changed; try again when they have settled.',
    );
  }

  process.exit(1);

  return claim;
};

const recoverInterrupted = ({ quiet = false } = {}) => {
  /*
   * Ownership before assessment, and certainly before anything is cleared.
   * This is the ordering the re-audit required: the old code assessed the
   * state, then branched on the lock, and a malformed lock walked straight
   * into the clearing paths below.
   */
  const claim = requireClaim('recovering an interrupted campaign');
  const owner = requireUnowned('Recovering or taking this state over');
  const assessment = assessRecovery({ projectRoot });

  if (assessment.action === 'none') {
    claim.release();

    return { settled: true, action: 'none' };
  }

  if (assessment.action === 'refuse') {
    console.error(`\nmutation recovery cannot be completed.\n\n${assessment.message}\n`);
    process.exit(1);
  }

  const clearStateFiles = () => {
    // Reverse of the order they were created in: journal, then marker, then
    // the lock. A kill inside this sequence leaves a state the assessment
    // above can still name.
    clearJournal(projectRoot);
    clearMarker(projectRoot);

    if (owner.state !== 'self') {
      rmSync(LOCK_FILE, { force: true });
    }
  };

  if (assessment.action === 'finalise') {
    // Nothing to put back, and it is established rather than assumed: no
    // journal was ever written under this marker (phase `started`), or
    // every file the marker recorded has been verified against the digest
    // and permissions it kept.
    //
    // Still the owner? `clearStateFiles` deletes the journal and marker,
    // which is exactly the evidence another owner would be relying on.
    requireStillClaimed(claim, 'clearing settled recovery state');
    clearStateFiles();
    claim.release();

    if (!quiet) {
      console.warn(`\n${assessment.message}\nRecovery state cleared; nothing needed restoring.\n`);
    }

    return { settled: true, action: 'finalise', reason: assessment.reason };
  }

  const journal = assessment.journal;

  console.warn(
    `\nan earlier campaign (pid ${String(journal.pid)}, mutant ${String(journal.mutantId)}) did not ` +
      'finish: recovering its files from the journal before going on.',
  );

  /*
   * The last check before source files are written. Everything above this
   * point only reads; everything below it puts bytes back on disk.
   */
  requireStillClaimed(claim, "restoring an interrupted campaign's files");

  const outcome = recoverJournal({ projectRoot, journal });
  const swept = sweepTemporaries(projectRoot, journal);

  for (const detail of outcome.details) {
    console.warn(`  ${detail}`);
  }

  for (const file of swept) {
    console.warn(`  ${file}: swept a half-written temporary file`);
  }

  if (!outcome.ok) {
    console.error(
      '\nrecovery refused. The files above are not what this campaign planted and not\n' +
        'what it recorded, so something else has changed them. Nothing was overwritten.\n' +
        `Inspect them, put them right, and run \`node scripts/mutation-test.mjs --recover\`\n` +
        `again. The journal has been left in place (${JOURNAL_FILE}).`,
    );
    process.exit(1);
  }

  /*
   * Only now, with every file verified against its recorded digest, is the
   * evidence allowed to go away — and only if this process is still the
   * one entitled to take it down. Losing the claim here must not produce a
   * success message, so the check precedes both the deletion and the
   * report (audit #5, F-3).
   */
  requireStillClaimed(claim, 'clearing the recovery evidence it has just used');
  clearStateFiles();
  claim.release();

  if (!quiet) {
    console.warn(
      `recovered: ${String(outcome.restored.length)} file(s) restored, ` +
        `${String(outcome.skipped.length)} already correct. The tree is as the campaign found it.\n`,
    );
  }

  return { settled: true, action: 'recover', restored: outcome.restored.length };
};

/**
 * `--clear-recovery-state`: the supported way out of the one state recovery
 * cannot finish by itself — an interrupted campaign whose journal is gone
 * (audit D-1, D-5). It is not `rm -rf`: it clears the state only when the
 * marker's own digests show the tree already matches the originals, which is
 * exactly the condition under which clearing it is safe.
 *
 * "Safe" has to be shown, not assumed (re-audit R-2). An empty file list, a
 * list that is not a list, and a list whose entries carry no usable original
 * digest are all *insufficient evidence*: they are refusals, never passes.
 * The old build filtered such a list for mismatches, found none because it
 * had checked nothing, and announced that every file matched.
 */
const clearRecoveryState = () => {
  // Ownership first, exactly as in recovery: this command deletes state,
  // and the live campaign it might belong to has the same claim on it.
  const claim = requireClaim('clearing interrupted recovery state');

  requireUnowned('Clearing this state');

  const assessment = assessRecovery({ projectRoot });

  if (assessment.action === 'none') {
    console.log(
      'there is no recovery state to clear.\n' +
        'That describes the state files only; it says nothing about whether the working\n' +
        'tree is clean. Check `git status --short -- src` if you are unsure.',
    );
    process.exit(0);
  }

  if (assessment.action === 'recover') {
    console.error(
      'there is a usable recovery journal: this state can be settled properly.\n' +
        'Run `node scripts/mutation-test.mjs --recover` instead — it restores the files\n' +
        'and verifies every byte it writes.',
    );
    process.exit(1);
  }

  /*
   * Positive evidence or nothing (R-2). The previous build filtered a list
   * of verdicts for non-original files and cleared the state when the
   * filter came back empty — which it does when the marker recorded no
   * files at all, or a file list that was not a list. It then announced
   * that every recorded file matched its original digest, having checked
   * none. A refusal to produce verdicts is now a refusal to clear.
   */
  const verdicts = assessment.verdicts ?? [];

  if (assessment.action === 'refuse' && verdicts.length === 0) {
    console.error(
      `refusing to clear the recovery state: there is no usable evidence to check the\n` +
        'working tree against, so clearing it could hide a mutated tree.\n\n' +
        `${assessment.message}`,
    );
    process.exit(1);
  }

  const outstanding = verdicts.filter((entry) => entry.state !== 'original');

  if (outstanding.length > 0) {
    console.error(
      'refusing to clear the recovery state: these files do not match the originals the\n' +
        'marker recorded, so clearing it would hide a mutated working tree.\n' +
        `${outstanding.map((entry) => `  · ${entry.file} (${entry.state})`).join('\n')}\n\n` +
        'Restore them from version control (`git restore <file>`), then run this again.',
    );
    process.exit(1);
  }

  if (assessment.action !== 'finalise') {
    console.error(
      `refusing to clear the recovery state: ${assessment.reason}.\n\n${assessment.message}`,
    );
    process.exit(1);
  }

  /*
   * The verdicts above were produced from state read some time ago. This
   * command exists to delete that state, so re-assert ownership before
   * the deletion rather than after it (audit #5, F-3).
   */
  requireStillClaimed(claim, 'clearing the interrupted recovery state');

  clearJournal(projectRoot);
  clearMarker(projectRoot);
  rmSync(LOCK_FILE, { force: true });
  claim.release();

  console.log(
    `every one of the ${String(verdicts.length)} file(s) the interrupted campaign recorded matches its\n` +
      'original bytes and permissions. The recovery state has been cleared.',
  );
  process.exit(0);
};

const acquireLock = () => {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });

  const owner = ownerIdentity(process.pid);
  const record = JSON.stringify({
    pid: process.pid,
    // Not "a process with this pid is alive" but "the process that took
    // this lock is alive": a pid the kernel has since handed to something
    // else no longer matches.
    owner,
    startedAt: new Date().toISOString(),
    secretDigest: authorisation.secretDigest,
  });

  /*
   * A campaign must not start under a suite that is already running: the
   * interlock only ever checked at *suite* startup, so a campaign begun
   * afterwards rewrote source underneath an admitted suite (audit B-2).
   * The check is made after the lock is in hand and before anything is
   * mutated, and the lock is given back if a suite is found, so the two
   * sides cannot both proceed.
   */
  const refuseIfSuitesRunning = () => {
    const readers = liveReaders({ projectRoot, excludePid: process.pid });

    if (readers.length === 0) {
      return;
    }

    rmSync(LOCK_FILE, { force: true });
    clearMarker(projectRoot);
    holdsLock = false;

    console.error(
      `refusing to start: ${String(readers.length)} test process(es) are already running\n` +
        'against this working tree:\n' +
        `${readers.map((r) => `  · pid ${String(r.pid ?? 'unknown')} — ${r.evidence}`).join('\n')}\n\n` +
        'A campaign rewrites production source while it runs, so those suites would\n' +
        'read half-mutated files and report failures that are not real. The lock has\n' +
        'been released and nothing was mutated. Wait for them to finish.',
    );

    process.exit(1);
  };

  const take = () => {
    writeFileSync(LOCK_FILE, record);
    holdsLock = true;
    lockRecordBytes = Buffer.from(record);
    // Marker immediately after the lock and before any test runs, so from
    // here on an interruption is visible even with nothing yet mutated.
    writeMarker({ projectRoot, pid: process.pid, owner, phase: 'started' });
    refuseIfSuitesRunning();
  };

  try {
    writeFileSync(LOCK_FILE, record, { flag: 'wx' });
    holdsLock = true;
    lockRecordBytes = Buffer.from(record);
    writeMarker({ projectRoot, pid: process.pid, owner, phase: 'started' });
    refuseIfSuitesRunning();

    return;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  /*
   * Something is already here. The question of who owns it is answered in
   * one place, from the lock *and* the marker together, and a lock that
   * cannot be parsed makes the answer less certain rather than more. A
   * live owner is refused with or without --force (G-e); an owner that
   * cannot be resolved is refused too, and --force does not override it.
   * Only a conclusively absent owner is taken over.
   */
  /*
   * The takeover below used to be a plain write: two processes that both
   * saw the same stale lock both passed the ownership check and both wrote
   * themselves in, after which both mutated the same files (audit B-1,
   * observed as a collision on one file's atomic rename). The claim makes
   * the whole take-over sequence exclusive.
   */
  const claim = requireClaim('taking over an abandoned campaign lock');
  const held = requireUnowned('Starting a second campaign');

  if (held.state === 'stale') {
    console.warn(
      `warning: taking over a campaign lock from pid ${String(held.pid)}: ${held.evidence}.`,
    );
  } else if (held.state === 'none') {
    // The lock existed a moment ago and does not now; nothing owns it.
    console.warn('warning: replacing a campaign lock that no process owns.');
  }

  /*
   * Recovery runs before this function, so any interrupted work has
   * already been settled or has stopped the run. Re-check rather than
   * trust that: taking a lock on top of unsettled state is precisely how a
   * second writer gets in.
   */
  const assessment = assessRecovery({ projectRoot });

  if (assessment.action !== 'none') {
    console.error(
      'refusing to start: there is unsettled mutation recovery state beside this lock.\n' +
        'Run `node scripts/mutation-test.mjs --recover` first.\n\n' +
        `${assessment.message}`,
    );
    process.exit(1);
  }

  take();
  claim.release();
};

const releaseLock = () => {
  if (!holdsLock) {
    return;
  }

  /*
   * Conditional on the bytes, for the same reason claim release is: a
   * campaign that has lost the state must not delete the lock belonging
   * to the campaign that took it over. `holdsLock` alone only records
   * what this process once did, not what is on disk now.
   */
  const mine = holdsCampaignLock();

  holdsLock = false;

  if (mine) {
    rmSync(LOCK_FILE, { force: true });
  }
};

/* The marker's phase, as this campaign moves through its transaction. */
const ownIdentity = ownerIdentity(process.pid);

const markPhase = (phase, { mutantId = null, files = [] } = {}) => {
  // Not merely "this process took the lock once" but "the lock on disk is
  // still this process's": a marker written after losing the state would
  // overwrite the current owner's own record of its transaction.
  if (!holdsCampaignLock()) {
    return;
  }

  writeMarker({ projectRoot, pid: process.pid, owner: ownIdentity, phase, mutantId, files });
};

/** The snapshots of whatever mutant is planted right now, or null. */
let planted = null;

/**
 * The file identities of the mutation in flight — path, original digest,
 * mutated digest and mode. Carried into *every* marker phase, including
 * `restored`, because a phase name is not evidence: the re-audit (R-3)
 * finalised a `restored` marker that recorded no files and reported success
 * with a mutant still on disk.
 */
let plantedFiles = [];

/** Puts every mutated file back. Synchronous, so it is safe from a signal. */
const unplant = () => {
  if (planted === null) {
    return;
  }

  /*
   * The same authority check the ordinary restore path makes, because this
   * is the same write arriving by a different route — an exit hook or a
   * signal. Without it the guard in `restore()` would be decorative: a
   * campaign that stopped because it had lost the lock would reach
   * `process.on('exit')` a moment later and put its files back anyway,
   * on top of whatever the new owner was doing.
   *
   * Leaving the journal and marker untouched is the point. They are a
   * complete description of the transaction, and they belong to the
   * process that now holds the lock.
   */
  if (!holdsCampaignLock()) {
    console.error(
      'not restoring: another process now holds the campaign lock, and the recovery\n' +
        'journal for these files has been left in place for it.',
    );

    planted = null;

    return;
  }

  for (const [path, contents] of planted) {
    writeFileSync(path, contents);
  }

  planted = null;

  /*
   * Order matters, and it is the reverse of the order these were created
   * in. `restored` first: from here on the files are back, so a kill leaves
   * a state that says "only cleanup was outstanding". Then the journal,
   * whose work is done. Then back to `started`, which means "this campaign
   * holds the lock and nothing is mutated".
   */
  markPhase('restored', { files: plantedFiles });
  clearJournal(projectRoot);
  plantedFiles = [];
  markPhase('started');
};

process.on('exit', () => {
  unplant();

  /*
   * Marker before lock. The window between the two is "a marker with no
   * lock", which assessRecovery reads as `finalise` — nothing to put back.
   * Releasing the lock first would leave a window in which a second
   * campaign could start while this one's state was still on disk.
   */
  if (holdsCampaignLock()) {
    clearMarker(projectRoot);
  }

  releaseLock();
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.error(`\n${signal}: restoring the mutated files before exiting.`);
    unplant();

    if (holdsCampaignLock()) {
      clearMarker(projectRoot);
    }

    releaseLock();
    process.exit(130);
  });
}

const RENDERER = 'src/renderer/src';

/** Suites, by the area a mutant belongs to. */
const SUITES = {
  breakpoint: [`${RENDERER}/reader/chrome.test.tsx`, 'tests/unit/styles/responsive.test.ts'],
  announcement: [
    `${RENDERER}/reader/WordAnnouncement.test.tsx`,
    `${RENDERER}/reader/states.test.tsx`,
  ],
  messages: [
    `${RENDERER}/ui/Message.test.tsx`,
    `${RENDERER}/ui/states.test.tsx`,
    `${RENDERER}/reader/states.test.tsx`,
    `${RENDERER}/app/App.test.tsx`,
  ],
  styles: ['tests/unit/styles'],
  lookup: [`${RENDERER}/reader/dictionary/useDictionaryLookup.test.tsx`],
  names: [`${RENDERER}/reader/states.test.tsx`, `${RENDERER}/reader/ReaderToolbar.chrome.test.tsx`],
  motion: [
    'tests/unit/styles',
    'src/core/persistence/motion.test.ts',
    `${RENDERER}/theme/applyMotion.test.tsx`,
  ],
  // 6.8. Split by where a settings fault would land, so a mutant runs the
  // suites that are supposed to notice it and not the whole campaign.
  preferences: [
    'src/core/persistence/preferences.test.ts',
    'src/core/persistence/schema.test.ts',
    'src/core/persistence/readerState.test.ts',
  ],
  preferenceIpc: [
    'src/main/ipc/registerStateIpcHandlers.test.ts',
    'src/main/state/readerStateService.test.ts',
  ],
  settingsUi: [
    `${RENDERER}/settings/SettingsPanel.test.tsx`,
    `${RENDERER}/settings/usePreferences.test.tsx`,
    `${RENDERER}/app/settings.test.tsx`,
  ],
  settingsReader: [`${RENDERER}/reader/preferences.test.tsx`],
  windowTheme: ['src/main/theme/windowTheme.test.ts'],
  /*
   * M7.2. Two groups, because a failure-vocabulary defect lands either in
   * the main process (what the reply says) or in the renderer (what is
   * done with it), and running the half that cannot notice is waste.
   */
  failureVocabulary: [
    'src/main/documents/documentFile.test.ts',
    'src/main/ipc/registerDocumentIpcHandlers.test.ts',
    'src/main/state/readerStateService.test.ts',
    `${RENDERER}/reader/documentFailure.test.ts`,
    `${RENDERER}/reader/useReaderDocument.test.tsx`,
  ],
  /*
   * M7.1. Three groups: the main-process state machine that decides what
   * a dead renderer means, the last-resort handlers around it, and the
   * renderer's boundary and notice. A containment defect lands in one of
   * the three, and running the other two proves nothing.
   */
  rendererRecovery: [
    'src/main/window/rendererRecovery.test.ts',
    'tests/integration/sessionRecoveryBoundary.test.ts',
  ],
  processGuards: ['src/main/lifecycle/processGuards.test.ts'],
  crashSurface: [
    `${RENDERER}/app/ErrorBoundary.test.tsx`,
    `${RENDERER}/app/crashRecovery.test.tsx`,
    'tests/unit/chrome/testIdInventory.test.ts',
  ],
  /*
   * M7.3. Three groups: who is allowed to write (the single-instance
   * claim), how a write reaches the disk (the store's durability and
   * retry behaviour), and whether quitting waits for it.
   */
  singleInstance: ['src/main/lifecycle/singleInstance.test.ts'],
  forwardedDocuments: ['src/main/lifecycle/forwardedDocuments.test.ts'],
  stateDurability: [
    'src/main/persistence/readerStateDurability.test.ts',
    'src/main/persistence/readerStateStore.test.ts',
  ],
  quitFlush: ['src/main/lifecycle/quitFlush.test.ts'],
  persistenceNotice: [
    `${RENDERER}/app/usePersistenceNotice.test.tsx`,
    `${RENDERER}/app/persistence.test.tsx`,
    `${RENDERER}/reader/useReadingPosition.test.tsx`,
    'src/main/persistence/readerStateStore.test.ts',
  ],
};

/**
 * The catalogue.
 *
 * `find` must match the production occurrence exactly once in spirit: the
 * harness replaces the first occurrence, so a string that also appears in
 * a comment above the code is a mistake that shows up as a survivor. Two
 * of the 6.5 campaign's original "survivors" were exactly that.
 */
const MUTANTS = [
  // ---- 6.5 closure pass: the audit's findings ------------------------
  {
    id: 'R1-recents-meta-reparented',
    suite: 'styles',
    file: `${RENDERER}/styles/reader.css`,
    find: '.recents__meta {\n  color: var(--colour-text-muted);\n}\n\n/* CTL-4: wide enough for a five-digit page number without scrolling. */\n.reader__page-input {',
    replace:
      '.recents__meta,\n/* CTL-4: wide enough for a five-digit page number without scrolling. */\n.reader__page-input {',
    description: 'the defect 7de334e shipped: the metadata rule re-parented into the page field',
  },
  {
    id: 'R2-recents-meta-colour',
    suite: 'styles',
    file: `${RENDERER}/styles/reader.css`,
    find: '.recents__meta {\n  color: var(--colour-text-muted);\n}',
    replace: '.recents__meta {\n  color: var(--colour-text);\n}',
    description: 'metadata stops being secondary text',
  },
  {
    id: 'R3-app-info-leak',
    suite: 'messages',
    file: `${RENDERER}/app/useAppInfo.ts`,
    find: "state: { status: 'unavailable', reason: 'request-failed' },",
    replace: "state: { status: 'unavailable', reason: String(error) as AppInfoFailure },",
    description: 'the rejected IPC call speaks to the reader again',
    also: [
      {
        file: `${RENDERER}/app/useAppInfo.ts`,
        find: '      .catch(() => {',
        replace: '      .catch((error: unknown) => {',
      },
    ],
  },
  {
    id: 'R4-open-failure-leak',
    suite: 'messages',
    file: `${RENDERER}/reader/ReaderView.tsx`,
    find: '              <Message kind="problem">{state.message}</Message>',
    replace:
      '              <Message kind="problem">{state.message}</Message>\n              {state.cause !== undefined && <p className="reader__cause">{state.cause}</p>}',
    description: 'the engine wording returns to the failure screen',
  },
  {
    id: 'R5-loading-threshold-halved',
    suite: 'lookup',
    file: `${RENDERER}/reader/dictionary/useDictionaryLookup.ts`,
    find: 'export const LOADING_DELAY_MS = 120;',
    replace: 'export const LOADING_DELAY_MS = 60;',
    description: 'the 120 ms contract is quietly halved',
  },
  {
    id: 'R6-loading-threshold-removed',
    suite: 'lookup',
    file: `${RENDERER}/reader/dictionary/useDictionaryLookup.ts`,
    find: 'export const LOADING_DELAY_MS = 120;',
    replace: 'export const LOADING_DELAY_MS = 0;',
    description: 'every lookup flashes a busy state',
  },
  {
    id: 'R7-no-text-notice-announces',
    suite: 'announcement',
    file: `${RENDERER}/reader/ReaderView.tsx`,
    find: '<Message kind="info" announce={false}>',
    replace: '<Message kind="info">',
    description: 'the page-without-text notice becomes a live region again',
  },
  {
    id: 'R8-popup-problem-repainted',
    suite: 'styles',
    file: `${RENDERER}/styles/reader.css`,
    find: '.dictionary-popup__status:not(.message),',
    replace: '.dictionary-popup__status,',
    description: 'the popup surface repaints a failure message muted',
  },
  {
    id: 'R9-problem-floor-removed',
    suite: 'styles',
    file: `${RENDERER}/styles/global.css`,
    find: '.message--problem {\n  color: var(--colour-danger);',
    replace: '.message--problem {\n  color: var(--colour-text-muted);',
    description: 'a failure stops looking like one',
  },

  // ---- 6.5 itself: the conditions the audit closed -------------------
  {
    id: 'C1-js-boundary',
    suite: 'breakpoint',
    file: `${RENDERER}/reader/model/chrome.ts`,
    find: 'width >= SIDE_PANEL_BREAKPOINT',
    replace: 'width > SIDE_PANEL_BREAKPOINT',
    description: 'the view and the stylesheet disagree at exactly 1100',
  },
  {
    id: 'C1-css-boundary',
    suite: 'breakpoint',
    file: `${RENDERER}/styles/reader.css`,
    find: '@media (max-width: 1099.98px)',
    replace: '@media (max-width: 1100px)',
    description: 'the media query becomes inclusive again',
  },
  {
    id: 'C2-release-removed',
    suite: 'breakpoint',
    file: `${RENDERER}/styles/reader.css`,
    find: '  .reader__side-content {\n    width: 100%;\n  }\n',
    replace: '',
    description: 'the narrow window keeps the wide panel reservation',
  },
  {
    id: 'C3-announcement-leak',
    suite: 'announcement',
    file: `${RENDERER}/reader/WordAnnouncement.tsx`,
    find: "{word === null ? '' : word.display}",
    replace:
      "{word === null ? '' : `${word.display} (${word.raw}, ${String(interaction?.milliseconds ?? 0)} ms)`}",
    description: 'developer instrumentation leaks into the polite announcement',
  },
  {
    id: 'C4-announcement-hidden',
    suite: 'announcement',
    file: `${RENDERER}/reader/ReaderView.tsx`,
    find: '<WordAnnouncement interaction={words.interaction} />',
    replace: '',
    description: 'the live region goes back inside the collapsible panel',
  },
  {
    id: 'C6-duplicate-landmark-name',
    suite: 'names',
    file: `${RENDERER}/reader/ReaderToolbar.tsx`,
    find: 'aria-label="File"',
    replace: 'aria-label="Document"',
    description: 'two pieces of chrome answer to one name again',
  },

  // ---- 6.7: ADR-032's motion policy ---------------------------------
  {
    id: 'M1-motion-outside-the-fence',
    suite: 'motion',
    file: `${RENDERER}/styles/reader.css`,
    find: '.dictionary-popup {\n  z-index: 20;',
    replace:
      '.dictionary-popup {\n  transition: opacity var(--motion-base) var(--ease-out);\n  z-index: 20;',
    description: 'a fifth animation grows next to the component it belongs to',
  },
  {
    id: 'M2-reduced-motion-shortened',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: ":root[data-motion='reduced'] *::after {\n  animation: none;\n  transition: none;",
    replace:
      ":root[data-motion='reduced'] *::after {\n  animation-duration: 0.01ms;\n  transition-duration: 0.01ms;",
    description: 'the override shortens motion instead of disabling it, so events still fire',
  },
  {
    id: 'M3-explicit-preference-dropped',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: ":root[data-motion='reduced'],\n:root[data-motion='reduced'] *,",
    replace: ":root[data-motion='never-written'],\n:root[data-motion='never-written'] *,",
    description: 'only the operating system can ask for less motion; the preference cannot',
  },
  {
    id: 'M4-override-loses-its-rank',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: ":root[data-motion='reduced'],\n:root[data-motion='reduced'] *,\n:root[data-motion='reduced'] *::before,",
    replace:
      ":where(:root[data-motion='reduced']),\n:where(:root[data-motion='reduced'] *),\n:where(:root[data-motion='reduced'] *::before),",
    description: 'the override drops to zero specificity and starts depending on source order',
  },
  {
    id: 'M5-entry-gains-an-end-state',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: '@keyframes search-enter {\n  from {\n    opacity: 0;\n  }\n}',
    replace:
      '@keyframes search-enter {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}',
    description: 'the keyframe dictates the resting opacity, so the panel can be stranded',
  },
  {
    id: 'M6-popup-moves-away-from-the-word',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: '@keyframes popup-enter-above {\n  from {\n    opacity: 0;\n    transform: translateY(-3px);',
    replace:
      '@keyframes popup-enter-above {\n  from {\n    opacity: 0;\n    transform: translateY(3px);',
    description: 'the flipped popup slides away from its anchor instead of towards it',
  },
  {
    id: 'M7-transition-reaches-a-resting-control',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: ':where(.control:is(:hover, :focus-visible):enabled) {',
    replace: '.control,\n:where(.control:is(:hover, :focus-visible):enabled) {',
    description: 'an idle control carries a transition, so a theme change cross-fades',
  },
  {
    id: 'M8-keyframe-animates-a-layout',
    suite: 'motion',
    file: `${RENDERER}/styles/global.css`,
    find: '@keyframes undo-enter {\n  from {\n    opacity: 0;\n    transform: translateY(4px);',
    replace: '@keyframes undo-enter {\n  from {\n    opacity: 0;\n    height: 0;',
    description: 'an entry animates a property that costs a layout on every frame',
  },
  {
    id: 'M9-system-resolves-to-reduced',
    suite: 'motion',
    file: 'src/core/persistence/motion.ts',
    find: "preference === 'always' ? 'reduced' : 'system'",
    replace: "preference === 'always' ? 'reduced' : 'reduced'",
    description: 'following the system silently means never moving',
  },
  {
    id: 'M10-attribute-written-unresolved',
    suite: 'motion',
    file: `${RENDERER}/theme/applyMotion.ts`,
    find: 'root.setAttribute(MOTION_ATTRIBUTE, resolveMotion(preference));',
    replace: 'root.setAttribute(MOTION_ATTRIBUTE, preference);',
    description: 'the preference is written where the cascade expects the resolved state',
  },
  // ---- 6.8: settings (ADR-031) --------------------------------------
  {
    id: 'S1-invalid-enum-accepted',
    suite: 'preferences',
    file: 'src/core/persistence/preferences.ts',
    find:
      'const parseDefaultZoomMode = (value: unknown): DefaultZoomMode =>\n' +
      '  DEFAULT_ZOOM_MODES.find((candidate) => candidate === value) ??\n' +
      '  DEFAULT_PREFERENCES.defaultZoomMode;',
    replace:
      'const parseDefaultZoomMode = (value: unknown): DefaultZoomMode =>\n' +
      '  (value ?? DEFAULT_PREFERENCES.defaultZoomMode) as DefaultZoomMode;',
    description: 'an unknown preference value is stored instead of falling back to the default',
  },
  {
    id: 'S2-future-schema-interpreted',
    suite: 'preferences',
    file: 'src/core/persistence/schema.ts',
    find: "    return recovered('future-schema-version');",
    replace: '    return { state: emptyReaderState(), recoveredFrom: null, droppedRecords: 0 };',
    description: 'a state file from a newer build is interpreted rather than quarantined',
  },
  {
    id: 'S3-version-1-block-adopted',
    suite: 'preferences',
    file: 'src/core/persistence/schema.ts',
    find: '  1: (document) => ({ ...document, schemaVersion: 2, preferences: DEFAULT_PREFERENCES }),',
    replace: '  1: (document) => ({ ...document, schemaVersion: 2 }),',
    // The migration is the only thing that stops a stray block in a
    // version-1 file from being adopted, which is why dropping it has to
    // be visible to a test.
    description: 'a preference block is believed in a document whose version does not promise one',
  },
  {
    id: 'S4-no-default-for-rubbish',
    suite: 'preferences',
    file: 'src/core/persistence/preferences.ts',
    find: '  const source = isObject(value) ? value : {};',
    replace: '  const source = value as Record<string, unknown>;',
    description: 'a preference block that is not an object stops resolving to the defaults',
  },
  {
    id: 'S5-duplicate-persistence-key',
    suite: 'preferences',
    file: 'src/core/persistence/schema.ts',
    find: '      preferences: parsePreferences(state.preferences),',
    replace:
      '      preferences: parsePreferences(state.preferences),\n' +
      '      motionPreference: state.preferences.reduceMotion,',
    description: 'a second spelling of a preference is written beside the canonical one',
  },
  {
    id: 'S6-preferences-dropped-by-a-document-write',
    suite: 'preferences',
    file: 'src/core/persistence/readerState.ts',
    find:
      'export const forgetDocument = (state: ReaderState, id: string): ReaderState => ({\n' +
      '  ...state,',
    replace:
      'export const forgetDocument = (state: ReaderState, id: string): ReaderState => ({\n' +
      '  preferences: DEFAULT_PREFERENCES,',
    description: 'a document write drops the preference block beside it',
  },
  {
    id: 'S7-unguarded-preference-ipc',
    suite: 'preferenceIpc',
    file: 'src/main/ipc/registerStateIpcHandlers.ts',
    // The signature gained a return type in M7.2 (the channel now answers
    // with the write health); the mutant is unchanged in substance.
    find: '    guard(IpcChannel.SavePreferences, async (raw: unknown): Promise<StateWriteHealth> => {',
    replace: '    (0, async (raw: unknown): Promise<StateWriteHealth> => {',
    description: 'the preferences channel answers a sender it has not checked',
  },
  {
    id: 'S8-unvalidated-preference-payload',
    suite: 'preferenceIpc',
    file: 'src/main/ipc/registerStateIpcHandlers.ts',
    find: '      const preferences = parsePreferencesUpdate(raw);',
    replace: '      const preferences = raw as Preferences | null;',
    description: 'whatever the renderer sends is written, extra keys and all',
  },
  {
    id: 'S9-appearance-not-reaching-the-window',
    suite: 'windowTheme',
    file: 'src/main/theme/windowTheme.ts',
    find: '      window.setBackgroundColor(resolveWindowBackground(appearance, systemTheme));\n      unsubscribe = watchSystemTheme({ window, appearance, systemTheme, stopOnClose: false });',
    replace:
      '      unsubscribe = watchSystemTheme({ window, appearance, systemTheme, stopOnClose: false });',
    description: 'the native window stops following a change of the appearance preference',
  },
  {
    id: 'S10-motion-bypasses-the-model',
    suite: 'settingsUi',
    file: `${RENDERER}/settings/usePreferences.ts`,
    find: '  applyMotion(document.documentElement, preferences.reduceMotion);',
    replace: "  document.documentElement.setAttribute('data-motion', preferences.reduceMotion);",
    description: 'the settings write the motion attribute themselves instead of resolving it',
  },
  {
    id: 'S11-preference-never-stored',
    suite: 'settingsUi',
    file: `${RENDERER}/settings/usePreferences.ts`,
    /*
     * M7.2 gave the fulfilled branch a body (it reports the write
     * health), so the statement is now six lines rather than one. It is
     * matched whole and replaced whole: a partial match would leave
     * unbalanced parentheses, and a file that does not parse is not a
     * mutant — it is a broken run that proves nothing.
     */
    find:
      '      void bridge?.savePreferences(next).then(\n' +
      '        (health) => {\n' +
      '          onWriteHealth?.(health);\n' +
      '        },\n' +
      '        () => undefined,\n' +
      '      );',
    replace: '      void next;',
    description: 'a chosen preference applies but is never sent to the main process',
  },
  {
    id: 'S12-zoom-preference-ignored',
    suite: 'settingsReader',
    file: `${RENDERER}/reader/ReaderView.tsx`,
    find: '    setZoom(ready.restored?.zoom ?? openingZoom);',
    replace: '    setZoom(ready.restored?.zoom ?? DEFAULT_ZOOM);',
    description: 'the default-zoom preference is silently ignored when a document opens',
  },
  {
    id: 'S13-stored-position-overruled',
    suite: 'settingsReader',
    file: `${RENDERER}/reader/ReaderView.tsx`,
    find: '    setZoom(ready.restored?.zoom ?? openingZoom);',
    replace: '    setZoom(openingZoom);',
    description: 'the preference overrules the zoom a document was actually left at',
  },
  {
    id: 'S14-diagnostics-default-on',
    suite: 'preferences',
    file: 'src/core/persistence/preferences.ts',
    find: "  showDeveloperDiagnostics: 'off',\n};",
    replace: "  showDeveloperDiagnostics: 'on',\n};",
    description: 'developer diagnostics default to open, undoing the 6.4 demotion',
  },
  /*
   * The two mutants at the seam the 6.8 closure audit found: the main
   * process records an open before it answers what zoom the open should
   * use. Both reproduce a real defect rather than a hypothetical one —
   * the first is the shipped 6.8 behaviour.
   */
  {
    id: 'S16-open-recorded-before-zoom-read',
    suite: 'preferenceIpc',
    file: 'src/main/state/readerStateService.ts',
    find: '      const previousZoom = lastUsedZoom(state, result.document.id);',
    replace:
      '      const previousZoom = lastUsedZoom(rememberOpen(state, { id: result.document.id, path, name: result.document.name, sizeBytes: result.document.sizeBytes, pageCount: known?.pageCount ?? null, at: now().toISOString() }));',
    description:
      'the document being opened is recorded before its previous zoom is read, so last-used reports the new document',
  },
  {
    id: 'S17-current-document-not-excluded',
    suite: 'preferenceIpc',
    file: 'src/main/state/readerStateService.ts',
    find: 'lastUsedZoom(state, result.document.id)',
    replace: 'lastUsedZoom(state)',
    description: 'the document being opened can answer as the document read before it',
  },
  {
    id: 'S15-diagnostics-preference-ignored',
    suite: 'settingsReader',
    file: `${RENDERER}/reader/DeveloperDiagnostics.tsx`,
    find: '  const [open, setOpen] = useState(startOpen);',
    replace: '  const [open, setOpen] = useState(false);',
    description: 'the diagnostics preference no longer opens the disclosure',
  },
  /*
   * ---- M7.2: one failure vocabulary (ADR-034) ------------------------
   *
   * Each of these five reinstates one of the defects the slice removed.
   * F1 and F2 are the leak itself, in the two shapes it took; F3 is the
   * silence that made a failed explicit open look like a cancelled one;
   * F4 and F5 are the two halves of the persistence notice — showing it
   * at all, and showing it only once.
   */
  {
    id: 'F1-raw-error-message-as-reason',
    suite: 'failureVocabulary',
    file: 'src/main/documents/documentFile.ts',
    find: '    return failed(classifyReadFailure(error), describe(error));',
    replace: "    return { status: 'unreadable', reason: describe(error), name };",
    description:
      'the pre-M7.2 defect: the exception message is returned as the reason, carrying the errno and the path',
  },
  {
    id: 'F2-path-in-renderer-facing-name',
    suite: 'failureVocabulary',
    file: 'src/main/documents/documentFile.ts',
    find: 'export const displayName = (path: string): string =>\n  basename(path)',
    replace: 'export const displayName = (path: string): string =>\n  String(path)',
    description: 'the absolute path travels to the renderer as the document name',
  },
  {
    id: 'F3-explicit-open-failure-ignored',
    suite: 'failureVocabulary',
    file: `${RENDERER}/reader/useReaderDocument.ts`,
    find: "      if (initial.status === 'unreadable') {\n        await accept(initial);\n        return;\n      }",
    replace: "      if (initial.status === 'unreadable') {\n        return;\n      }",
    description:
      'a document named on the command line that cannot be opened fails silently, as it did before M7.2',
  },
  {
    id: 'F4-persistence-notice-removed',
    suite: 'persistenceNotice',
    file: `${RENDERER}/app/usePersistenceNotice.ts`,
    find: "      setState((current) => (current === 'quiet' ? 'shown' : current));",
    replace: '      setState((current) => current);',
    description: 'a failing write is swallowed again: the reader is never told their state is lost',
  },
  {
    id: 'F5-notice-repeats-every-failure',
    suite: 'persistenceNotice',
    file: `${RENDERER}/app/usePersistenceNotice.ts`,
    find: "      setState((current) => (current === 'quiet' ? 'shown' : current));",
    replace: "      setState('shown');",
    description:
      'the once-per-session rule is gone: every failed write re-raises the notice, including after dismissal',
  },
  {
    id: 'F6-write-health-always-ok',
    suite: 'persistenceNotice',
    file: 'src/main/persistence/readerStateStore.ts',
    find: "      health = 'failing';",
    replace: "      health = 'ok';",
    description:
      'the store reports a failed write as a healthy one, so nothing downstream can react',
  },

  // ---- M7.1: failure containment ------------------------------------
  {
    id: 'K1-renderer-death-unhandled',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: '      if (isCleanExit(death)) {',
    replace: '      if (true as boolean) {',
    description:
      'R1 restored: every renderer death is treated as a clean exit, so nothing is detected',
  },
  {
    id: 'K2-recovery-never-attempted',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: '          reload();\n          return;',
    replace: '          return;',
    description: 'the death is logged but the window is never reloaded: a dead window, politely',
  },
  {
    id: 'K3-recovery-repeated-for-ever',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: "        case 'recovering':\n        case 'recovered': {",
    replace: "        case 'nothing-matches-this':\n        case 'nor-this': {",
    description: 'the one-attempt bound is gone: every crash reloads again, for ever',
  },
  {
    id: 'K4-second-death-not-terminal',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: '          onTerminalFailure();\n          return;',
    replace: '          return;',
    description: 'the second death goes quiet: no honest failure, no dialog, no destroyed window',
  },
  {
    id: 'K5-unresponsive-treated-as-death',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: '      if (!stalled) {\n        stalled = true;',
    replace: "      if (!stalled) {\n        state = 'failed';\n        stalled = true;",
    description: '§10 inverted: a window that is merely busy is declared unrecoverable',
  },
  {
    id: 'K6-responsive-does-not-clear',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: '      if (stalled) {\n        stalled = false;',
    replace: '      if (stalled) {',
    description: 'the transient never clears: the window is remembered as stalled for ever',
  },
  {
    id: 'K7-recovery-notice-suppressed',
    suite: 'rendererRecovery',
    file: 'src/main/window/rendererRecovery.ts',
    find: "      state === 'recovering' || state === 'recovered' ? 'after-crash' : 'none',",
    replace: "      'none',",
    description: 'the replacement window says nothing: the reader is never told it was rebuilt',
  },
  {
    id: 'K8-error-boundary-does-not-catch',
    suite: 'crashSurface',
    file: `${RENDERER}/app/ErrorBoundary.tsx`,
    find: "    return { phase: 'failed' };",
    replace: "    return { phase: 'healthy' };",
    description: 'R5 restored: the boundary catches and then renders nothing but the blank page',
  },
  {
    id: 'K9-recovery-affordance-removed',
    suite: 'crashSurface',
    file: `${RENDERER}/app/ErrorBoundary.tsx`,
    find: '          {!terminal && (',
    replace: '          {false && (',
    description: 'the failure surface appears with no way out of it',
  },
  {
    id: 'K10-raw-exception-displayed',
    suite: 'crashSurface',
    file: `${RENDERER}/app/ErrorBoundary.tsx`,
    find: '            {terminal ? BOUNDARY_TERMINAL_MESSAGE : BOUNDARY_FAILURE_MESSAGE}',
    replace:
      '            {terminal ? BOUNDARY_TERMINAL_MESSAGE : `Something went wrong: ${String(this.props.children)}`}',
    description: 'ADR-034 broken from the other end: raw detail put on the failure surface',
  },
  {
    id: 'K11-boundary-loop-unbounded',
    suite: 'crashSurface',
    file: `${RENDERER}/app/ErrorBoundary.tsx`,
    find: "      phase: current.recovering ? 'terminal' : 'failed',",
    replace: "      phase: 'failed',",
    description:
      'a reset that throws again is offered again: the button the reader can press for ever',
  },
  {
    id: 'K12-bootstrap-failure-silent',
    suite: 'processGuards',
    file: 'src/main/lifecycle/processGuards.ts',
    find: '  if (showErrorBox !== null) {',
    replace: '  if (false) {',
    description: 'start-up failure goes back to being invisible even when a box could be shown',
  },
  {
    id: 'K13-uncaught-exception-unlogged',
    suite: 'processGuards',
    file: 'src/main/lifecycle/processGuards.ts',
    find: '      onDiagnostic(`${kind}; the application cannot continue safely: ${describeFatal(error)}`);',
    replace: '      void kind;',
    description: 'R9 restored: the process dies at the top level with nothing written down',
  },
  {
    id: 'K14-guard-reentrancy-removed',
    suite: 'processGuards',
    file: 'src/main/lifecycle/processGuards.ts',
    find: '    if (tripped) {\n      // Already on the way out. A second report changes nothing and a\n      // second `terminate` would be a recursive failure handler.\n      return;\n    }',
    replace: '    if (false) {\n      return;\n    }',
    description:
      'the re-entrancy guard is gone: a failure inside the handler runs the handler again',
  },
  {
    id: 'K15-terminal-box-before-destroy',
    suite: 'processGuards',
    file: 'src/main/lifecycle/processGuards.ts',
    find: "  let closed = false;\n\n  try {\n    destroyWindow();\n    closed = true;\n  } catch (error: unknown) {\n    /*\n     * A window that cannot be closed must not prevent the reader being\n     * told. This is logged and then the message is shown anyway — the\n     * alternative is silence on top of a failure.\n     */\n    onDiagnostic(`the dead reader window could not be closed: ${describeFatal(error)}`);\n  }\n\n  /*\n   * Exactly one of the two diagnostics is written, and only the success\n   * one claims a closure (M7.1 audit finding CF-1). Logging both left\n   * the main-process evidence contradicting itself on the failure path,\n   * and let a reader of the log — or the runtime harness — infer a\n   * destruction that had not happened. The claim now follows the fact.\n   *\n   * Either way it is written before the blocking call, so the log still\n   * records what was attempted ahead of the modal.\n   */\n  if (closed) {\n    onDiagnostic('the dead reader window has been closed; showing the terminal message');\n  } else {\n    onDiagnostic('the dead reader window is still open; showing the terminal message anyway');\n  }\n\n  showErrorBox(RENDERER_LOST_TITLE, RENDERER_LOST_BODY);",
    replace:
      "  showErrorBox(RENDERER_LOST_TITLE, RENDERER_LOST_BODY);\n\n  let closed = false;\n\n  try {\n    destroyWindow();\n    closed = true;\n  } catch (error: unknown) {\n    /*\n     * A window that cannot be closed must not prevent the reader being\n     * told. This is logged and then the message is shown anyway — the\n     * alternative is silence on top of a failure.\n     */\n    onDiagnostic(`the dead reader window could not be closed: ${describeFatal(error)}`);\n  }\n\n  /*\n   * Exactly one of the two diagnostics is written, and only the success\n   * one claims a closure (M7.1 audit finding CF-1). Logging both left\n   * the main-process evidence contradicting itself on the failure path,\n   * and let a reader of the log — or the runtime harness — infer a\n   * destruction that had not happened. The claim now follows the fact.\n   *\n   * Either way it is written before the blocking call, so the log still\n   * records what was attempted ahead of the modal.\n   */\n  if (closed) {\n    onDiagnostic('the dead reader window has been closed; showing the terminal message');\n  } else {\n    onDiagnostic('the dead reader window is still open; showing the terminal message anyway');\n  }",
    description:
      'the C-1 defect restored: the blocking box is shown first, so the dead window stays painted underneath it',
  },
  {
    id: 'K16-closure-claimed-unconditionally',
    suite: 'processGuards',
    file: 'src/main/lifecycle/processGuards.ts',
    find: "  if (closed) {\n    onDiagnostic('the dead reader window has been closed; showing the terminal message');\n  } else {\n    onDiagnostic('the dead reader window is still open; showing the terminal message anyway');\n  }\n",
    replace:
      "  onDiagnostic('the dead reader window has been closed; showing the terminal message');\n",
    description:
      'CF-1 restored: the log claims the dead window has been closed even when the destroy threw',
  },
  {
    id: 'P1-single-instance-lock-removed',
    suite: 'singleInstance',
    file: 'src/main/lifecycle/singleInstance.ts',
    find: '  if (!app.requestSingleInstanceLock()) {',
    replace: '  if (false) {',
    description: 'R4 restored: the lock is never honoured, so every launch becomes another writer',
  },
  {
    id: 'P2-second-instance-unregistered',
    suite: 'singleInstance',
    file: 'src/main/lifecycle/singleInstance.ts',
    find: "  app.on('second-instance', (_event, argv) => {",
    replace: "  app.on('never-happens', (_event, argv) => {",
    description:
      'the handover is registered on an event that never fires: a second launch reaches nobody',
  },
  {
    id: 'P3-forwarded-document-ignored',
    suite: 'singleInstance',
    file: 'src/main/lifecycle/singleInstance.ts',
    find: '    onDiagnostic(`a second copy asked for ${requested}; opening it in the existing window`);\n    onForwardedDocument(requested);',
    replace:
      '    onDiagnostic(`a second copy asked for ${requested}; opening it in the existing window`);',
    description: 'the forwarded document is logged and then dropped on the floor',
  },
  {
    id: 'P4-temp-file-not-synced',
    suite: 'stateDurability',
    file: 'src/main/persistence/readerStateStore.ts',
    find: '      await files.writeFile(temporaryPath, contents);\n      await syncFileIfSupported(temporaryPath);',
    replace: '      await files.writeFile(temporaryPath, contents);',
    description:
      'R7 restored: the temporary file is renamed into place without being flushed to the disk',
  },
  {
    id: 'P5-temp-cleanup-removed',
    suite: 'stateDurability',
    file: 'src/main/persistence/readerStateStore.ts',
    find: "      warnOnce('write', `reading state could not be saved: ${describe(error)}`);\n      await discardTemporaryFile();",
    replace: "      warnOnce('write', `reading state could not be saved: ${describe(error)}`);",
    description: 'R8 restored: a failed rename leaves its temporary file behind, for ever',
  },
  {
    id: 'P6-cleanup-failure-rethrown',
    suite: 'stateDurability',
    file: 'src/main/persistence/readerStateStore.ts',
    find: "      warnOnce(\n        'cleanup',\n        `the temporary reading-state file could not be removed: ${describe(error)}`,\n      );",
    replace: '      throw error;',
    description: 'a cleanup that fails is turned into a thrown error instead of a diagnostic',
  },
  {
    id: 'P7-dirty-cleared-before-write',
    suite: 'stateDurability',
    file: 'src/main/persistence/readerStateStore.ts',
    find: '    const attempted = revision;\n    const contents = serializeReaderState(state);',
    replace:
      '    const attempted = revision;\n    const contents = serializeReaderState(state);\n    dirty = false;',
    description:
      'R6 restored: the pending delta is dropped before the write, so a failed write loses it',
  },
  {
    id: 'P8-retry-after-failure-removed',
    suite: 'stateDurability',
    file: 'src/main/persistence/readerStateStore.ts',
    find: "      health = 'failing';\n      warnOnce('write',",
    replace: "      health = 'failing';\n      dirty = false;\n      warnOnce('write',",
    description: 'a failed write clears the pending state, so nothing is ever retried',
  },
  {
    id: 'P9-quit-flush-not-awaited',
    suite: 'quitFlush',
    file: 'src/main/lifecycle/quitFlush.ts',
    find: "      event.preventDefault();\n\n      if (phase === 'flushing') {",
    replace: "      if (phase === 'flushing') {",
    description: 'L1 restored: quitting is never held for the pending write',
  },
  {
    id: 'P10-concurrent-update-lost',
    suite: 'stateDurability',
    file: 'src/main/persistence/readerStateStore.ts',
    find: '      if (revision === attempted) {\n        dirty = false;\n      }',
    replace: '      dirty = false;',
    description: 'an update that lands during a write is marked written and never reaches the disk',
  },
  {
    id: 'P11-forwarding-not-serialized',
    suite: 'forwardedDocuments',
    file: 'src/main/lifecycle/forwardedDocuments.ts',
    find: '          await deliver(next);\n          await awaitConsumption(next);',
    replace: '          await deliver(next);',
    description:
      'C-1 restored: the next forwarded document is handed over before the window has consumed the previous one, so a burst loses documents',
  },
  {
    id: 'P12-stale-request-completes-delivery',
    suite: 'forwardedDocuments',
    file: 'src/main/lifecycle/forwardedDocuments.ts',
    find: '      if (current === null || ticket <= ticketFloor) {',
    replace: '      if (current === null) {',
    description:
      'a request the renderer began before the delivery is allowed to complete it, which releases the queue too early',
  },
  {
    id: 'P13-quit-reports-success-regardless',
    suite: 'quitFlush',
    file: 'src/main/lifecycle/quitFlush.ts',
    find: "          finish(persistence === 'saved' ? 'flushed' : 'not-saved');",
    replace: "          finish('flushed');",
    description:
      'C-2 restored: quitting claims the reading state was flushed whatever the write actually did',
  },
];

const argv = process.argv.slice(2);
const only = (argv.find((argument) => argument.startsWith('--only=')) ?? '').slice(
  '--only='.length,
);
const selected = only.length > 0 ? only.split(',') : null;
const catalogue = MUTANTS.filter((mutant) => selected === null || selected.includes(mutant.id));

if (argv.includes('--list')) {
  for (const mutant of catalogue) {
    console.log(`${mutant.id.padEnd(28)} ${mutant.suite.padEnd(13)} ${mutant.description}`);
  }
  process.exit(0);
}

if (catalogue.length === 0) {
  console.error(`No mutant matches --only=${only}`);
  process.exit(2);
}

/*
 * Recovery comes first, always: an interrupted campaign's mutant is still in
 * the tree, and neither a new campaign's control run nor a plain --recover
 * can mean anything until it is out (M7.4 G-d, G-e).
 */
if (clearStateOnly) {
  clearRecoveryState();
}

const settled = recoverInterrupted();

if (recoverOnly) {
  /*
   * The exit status and the wording both have to mean something now. Before
   * the D-1 remediation this said "nothing further to do" and exited 0 even
   * when a campaign had been interrupted with source mutated and its
   * journal deleted. A zero here means one of exactly three things, and
   * recoverInterrupted() has already exited non-zero for everything else.
   */
  /*
   * Wording matters here, and the re-audit (R-4) is why. "No campaign state
   * found" is a statement about four files in one directory, and those
   * files are ignored by Git, so `git clean -fdX` or `-fdx` removes them
   * outright. It must not be read as "the working tree is clean" — the
   * runner cannot know that once its own evidence has been deleted.
   */
  console.log(
    {
      none:
        `no mutation recovery state was found in ${STATE_DIRECTORY}/.\n` +
        'That describes the state files this runner can see, and nothing more: it is\n' +
        'not a check of the working tree. Recovery evidence is ignored by Git, so a\n' +
        '`git clean -fdX` (or -fdx) removes it along with any record that a campaign\n' +
        'was interrupted. If a campaign may have been killed, compare the tree with\n' +
        'version control (`git status --short -- src`) and restore from a trusted\n' +
        'baseline if anything is unexpected.',
      recover: `recovery complete: ${String(settled.restored ?? 0)} file(s) restored, each verified against the digest and permissions recorded before it was mutated.`,
      finalise:
        'nothing needed restoring: the interrupted campaign had left no mutation in\n' +
        'place, and every file it recorded was verified against the marker before its\n' +
        'state was cleared.',
    }[settled.action],
  );
  process.exit(0);
}

acquireLock();

console.log(
  [
    '',
    '┌──────────────────────────────────────────────────────────────────────┐',
    '│  MUTATION CAMPAIGN RUNNING — the working tree is being mutated.      │',
    '│                                                                      │',
    '│  Production source files under src/ are rewritten with deliberate    │',
    '│  faults and restored a few seconds later. While this runs:           │',
    '│    · do not run npm test, npm run verify or a watcher — they would   │',
    '│      read a mutated file and report a failure that is not real;      │',
    '│    · do not commit; the tree on disk is not the tree in Git.         │',
    '│  Interrupting this script restores the files before it exits.        │',
    '└──────────────────────────────────────────────────────────────────────┘',
    '',
  ].join('\n'),
);

const reportDirectory = mkdtempSync(join(tmpdir(), 'mutation-'));

/** Runs one Vitest invocation and reads its JSON report. */
const runTests = (paths) => {
  const outputFile = join(reportDirectory, 'report.json');
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      ...paths,
      '--reporter=json',
      `--outputFile=${outputFile}`,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      /*
       * The suite now refuses to start while a campaign holds the lock
       * (M7.4 G-c). The campaign's own runs are the exception, and this is
       * how they prove it: the secret exists only in this process and in the
       * environment of the children it spawns. The lock carries its digest,
       * never the secret, so reading the lock buys an unrelated process
       * nothing.
       */
      env: {
        ...process.env,
        [AUTHORISATION_ENV.pid]: String(process.pid),
        [AUTHORISATION_ENV.secret]: authorisation.secret,
      },
    },
  );

  /*
   * A Vitest that was killed by a signal has not "found no failures": it
   * has found nothing. Ctrl-C reaches the whole process group, so the
   * runner dies first and this script would otherwise read its partial
   * report and announce a surviving mutant that was never tested.
   */
  if (result.signal !== null && result.signal !== undefined) {
    return {
      ran: false,
      interrupted: true,
      failed: 0,
      passed: 0,
      names: [],
      note: `the test runner was terminated by ${result.signal}`,
    };
  }

  let report;

  try {
    report = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch {
    return {
      ran: false,
      failed: 0,
      passed: 0,
      names: [],
      note: (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' | '),
    };
  }

  const names = report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => `${file.name.replace(`${projectRoot}/`, '')} > ${assertion.fullName}`),
  );

  return {
    ran: true,
    failed: report.numFailedTests ?? 0,
    passed: report.numPassedTests ?? 0,
    names,
    note: '',
  };
};

const edits = (mutant) => [
  { file: mutant.file, find: mutant.find, replace: mutant.replace },
  ...(mutant.also ?? []),
];

/** Applies a mutant, returning the snapshots needed to undo it. */
const apply = (mutant) => {
  const snapshots = new Map();

  /*
   * Everything is computed before anything is written. A mutant whose text
   * is no longer in the file must leave the tree untouched, and the journal
   * must describe the whole transaction — original bytes and the mutant that
   * is about to replace them — before the first byte changes (M7.4 G-d).
   */
  const planned = [];

  for (const edit of edits(mutant)) {
    const path = join(projectRoot, edit.file);
    const original = snapshots.get(path) ?? readFileSync(path, 'utf8');
    const basis = planned.findLast((entry) => entry.path === path)?.mutated ?? original;

    if (!basis.includes(edit.find)) {
      return null;
    }

    snapshots.set(path, original);
    planned.push({ path, original, mutated: basis.replace(edit.find, edit.replace) });
  }

  // One journal entry per file, carrying the bytes it starts with and the
  // bytes it is about to hold, so recovery can tell "the mutant this
  // campaign planted" from "something someone else edited".
  const finals = new Map();

  for (const entry of planned) {
    finals.set(entry.path, entry.mutated);
  }

  // Permissions are part of the file, and restoration has to put them back
  // as faithfully as the bytes (audit D-3).
  const modes = new Map([...finals.keys()].map((path) => [path, fileMode(path)]));

  const journalled = writeJournal({
    projectRoot,
    mutantId: mutant.id,
    pid: process.pid,
    entries: [...finals].map(([path, mutated]) => ({
      file: relative(projectRoot, path),
      original: snapshots.get(path),
      mutated,
      mode: modes.get(path),
    })),
  });

  /*
   * Durable, in this order, before a single source byte changes:
   *   1. the original bytes, in blobs named after their own digest;
   *   2. the journal that points at them;
   *   3. the marker, moved to `mutating` and carrying the same digests.
   *
   * (3) is what makes a lost journal detectable instead of silent: without
   * it, "no journal" and "journal deleted" are the same observation, which
   * is the whole of audit defect D-1.
   */
  plantedFiles = journalled.map((entry) => ({
    file: entry.file,
    originalDigest: entry.originalDigest,
    mutatedDigest: entry.mutatedDigest,
    mode: entry.mode,
  }));

  /*
   * The journal is on disk and names this campaign; the next statements
   * rewrite production source. If the lock is no longer ours another
   * campaign owns the tree, and planting a mutant now would corrupt its
   * run. The journal just written is harmless — it restores to the bytes
   * already on disk — so stopping here leaves nothing to undo.
   */
  if (!holdsCampaignLock()) {
    stopBecauseAuthorityLost('mutating production source');
  }

  markPhase('mutating', { mutantId: mutant.id, files: plantedFiles });

  // Published before the first write: a signal arriving between the journal
  // and the last write still restores every file.
  planted = snapshots;

  for (const [path, mutated] of finals) {
    // Written through a temporary file and a rename, so a kill mid-write
    // cannot leave a half-written production source file behind.
    writeFileDurably(path, mutated, { mode: modes.get(path) });
  }

  return snapshots;
};

const restore = (snapshots) => {
  /*
   * Restoration is itself a write to production source, so it needs the
   * same authority as planting did.
   *
   * Stopping here deliberately leaves the mutant on disk. That looks like
   * the wrong choice and is not: the journal and the `mutating` marker are
   * both intact and name every file with its original digest, so the state
   * is fully recoverable — whereas writing these snapshots back while the
   * new owner restores the same files from the same journal is two
   * processes renaming over one path, which is the collision that started
   * this slice. The owner finishes the transaction; this process does not
   * race it (audit #5, F-3).
   */
  if (!holdsCampaignLock()) {
    stopBecauseAuthorityLost('restoring the files it mutated');
  }

  for (const [path, contents] of snapshots) {
    writeFileDurably(path, contents, { mode: fileMode(path) });
  }

  planted = null;

  /*
   * The transaction is complete and verified by the write above. The record
   * of it is taken down in the reverse of the order it went up: phase
   * `restored` (the files are back), then the journal, then phase `started`
   * (this campaign still holds the lock, nothing is mutated). A kill at any
   * point in that sequence leaves a state that assessRecovery can name.
   */
  markPhase('restored', { files: plantedFiles });
  clearJournal(projectRoot);
  plantedFiles = [];
  markPhase('started');
};

const suitePaths = (mutant) => SUITES[mutant.suite] ?? [];

console.log('control: running the unmutated suites the catalogue uses');

const controlPaths = [...new Set(catalogue.flatMap(suitePaths))];
const control = runTests(controlPaths);

if (control.interrupted === true) {
  console.error(`\ninterrupted: ${control.note}. The mutated files have been restored.`);
  process.exit(130);
}

if (!control.ran || control.failed > 0) {
  console.error(
    `control is not green (${String(control.failed)} failed; ${control.note}) — results would mean nothing`,
  );
  rmSync(reportDirectory, { recursive: true, force: true });
  process.exit(1);
}

console.log(`control: ${String(control.passed)} passed, 0 failed\n`);

const survivors = [];
const invalid = [];

for (const mutant of catalogue) {
  const snapshots = apply(mutant);

  if (snapshots === null) {
    invalid.push(mutant.id);
    console.log(`INVALID  ${mutant.id} — its text is not in ${mutant.file}`);
    continue;
  }

  let outcome;

  try {
    outcome = runTests(suitePaths(mutant));
  } finally {
    restore(snapshots);
  }

  if (outcome.interrupted === true) {
    console.error(`\ninterrupted: ${outcome.note}. The mutated files have been restored.`);
    process.exit(130);
  }

  if (!outcome.ran) {
    // A mutant that stops the suite from running at all — a type error,
    // say — is a kill only if a test would have caught it anyway, so it
    // is reported separately rather than counted.
    invalid.push(mutant.id);
    console.log(`UNRUNNABLE ${mutant.id} — ${outcome.note}`);
    continue;
  }

  if (outcome.failed === 0) {
    survivors.push(mutant.id);
    console.log(`SURVIVED ${mutant.id} — ${mutant.description}`);
    continue;
  }

  console.log(`KILLED   ${mutant.id} (${String(outcome.failed)} failed) — ${mutant.description}`);
  for (const name of outcome.names) {
    console.log(`           ${name}`);
  }
}

rmSync(reportDirectory, { recursive: true, force: true });

const killed = catalogue.length - survivors.length - invalid.length;

console.log(
  `\n${String(killed)} killed, ${String(survivors.length)} survived, ${String(invalid.length)} not run, of ${String(catalogue.length)}`,
);

if (survivors.length > 0 || invalid.length > 0) {
  process.exit(1);
}
