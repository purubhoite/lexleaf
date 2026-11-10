/**
 * Campaign lock, authorisation and recovery journal for the mutation harness.
 *
 * A mutation campaign rewrites *real production files* and puts them back a
 * few seconds later. For those seconds the checkout on disk is not the
 * checkout in Git. Three hazards follow, and this module is the whole of the
 * answer to them (M7.4 slice 1; `docs/M7_INVESTIGATION.md` §14.8 G-c, G-d,
 * G-e):
 *
 * - **G-c** an unrelated `npm test` that overlaps a campaign reads a mutated
 *   file and reports a failure that is not real. The suite now refuses to
 *   start while a campaign is live — but the campaign's *own* test
 *   subprocesses must still run, so the interlock cannot be "fail whenever
 *   the lock exists". It is owner-specific: the lock carries only the
 *   *digest* of a secret the campaign generates, and the secret itself is
 *   handed to the campaign's children in their environment and nowhere else.
 *   Reading the lock file therefore tells an unrelated process nothing it can
 *   use.
 *
 * - **G-d** `SIGKILL` cannot be intercepted, so the exit/signal restore is not
 *   enough: a campaign killed with it left the tree mutated. Every mutation is
 *   now written down in a journal *before* the source file is touched, with
 *   the original bytes copied aside and both the original and the mutated
 *   digest recorded. A later invocation finishes the interrupted transaction
 *   before it does anything else. Recovery is idempotent, is restricted to
 *   files the campaign itself journalled, verifies every byte it writes
 *   against the recorded digest, and **fails closed** if the file on disk is
 *   neither the mutant it planted nor the original it expected — that is a
 *   file someone else has been editing, and overwriting it would destroy
 *   work.
 *
 * - **G-e** `--force` used to take over a lock whose holder was demonstrably
 *   alive, and called it "stale" while doing so. A live holder is now never
 *   bypassed.
 *
 * Everything here is pure or takes its filesystem through arguments, so the
 * decisions can be tested without a campaign, a signal or a sleep.
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository this module belongs to, resolved from the module's own
 * location rather than from `process.cwd()`.
 *
 * It matters that this is not the caller's working directory: the recovery
 * state of a *copy* of the repository must be that copy's, and a campaign
 * started from a subdirectory must find the same state as one started from
 * the root. A copied checkout carries its own copy of this file, so the root
 * it resolves is its own even when its dependencies are shared.
 */
export const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where the lock, the interrupted-campaign marker, the journal and the
 * journalled originals live.
 *
 * **Not** under `node_modules`. The independent audit of slice 1 (D-1)
 * demonstrated the consequence of putting them there: a campaign was killed
 * with SIGKILL while a mutant was on disk, `npm ci` then deleted the journal
 * and every original-content blob, and the documented recovery command
 * reported success — exit 0, "nothing further to do" — while production
 * source stayed mutated. Dependency directories are rebuilt, emptied and
 * (in this project's own sandbox, five times now) deleted wholesale.
 * Recovery evidence has to outlive that, so it lives next to the source it
 * describes, in a gitignored directory of its own.
 */
export const STATE_DIRECTORY = '.mutation-state';

export const campaignPaths = (projectRoot = defaultProjectRoot) => {
  const stateDirectory = join(projectRoot, STATE_DIRECTORY);

  return {
    stateDirectory,
    lockFile: join(stateDirectory, 'campaign.lock'),
    markerFile: join(stateDirectory, 'campaign.marker'),
    journalFile: join(stateDirectory, 'journal.json'),
    journalDirectory: join(stateDirectory, 'journal'),
    // The exclusive claim held across a recovery, a clear or a stale
    // takeover (audit B-1), and the directory where an admitted test suite
    // registers itself for its lifetime (audit B-2).
    claimFile: join(stateDirectory, 'campaign.claim'),
    readerDirectory: join(stateDirectory, 'readers'),
  };
};

/** The environment variables a campaign hands to its own test subprocesses. */
export const AUTHORISATION_ENV = {
  pid: 'MUTATION_CAMPAIGN_PID',
  secret: 'MUTATION_CAMPAIGN_SECRET',
};

export const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

/**
 * Compares two digests without leaking where they first differ. The threat
 * here is mild — anything that can run a test can read the lock file's
 * digest — but a comparison that short-circuits is the kind of detail that
 * gets copied into somewhere it matters.
 */
const digestsMatch = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
};

/** A fresh secret and the digest that goes in the lock in its place. */
export const mintAuthorisation = () => {
  const secret = randomBytes(32).toString('hex');

  return { secret, secretDigest: sha256(secret) };
};

/** `process.kill(pid, 0)`, with EPERM counted as alive (it is someone else's). */
export const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * An identity for the process that holds a pid *right now*, so that a pid
 * which has been recycled by an unrelated program is not mistaken for the
 * campaign that recorded it (audit D-5).
 *
 * Liveness alone cannot carry that weight: pids wrap, and on a busy machine
 * they wrap quickly. The identity used here is the kernel's own
 * "this process started at this tick, on this boot" pair, read from
 * `/proc`: field 22 of `/proc/<pid>/stat` (start time in clock ticks since
 * boot, which the kernel never reissues for the same pid within a boot)
 * together with the boot id. Both are observable without any privilege and
 * neither can be forged by the process being asked about.
 *
 * Returns `null` when this platform cannot answer — `/proc` is Linux's, and
 * no equivalent has been implemented or tested here. A `null` is never
 * treated as agreement: see `classifyLock`, which calls that case
 * `indeterminate` and fails closed.
 */
export const ownerIdentity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    // The second field is the executable name in parentheses and may itself
    // contain spaces and parentheses, so fields are counted from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = fields[19];

    if (startTime === undefined) {
      return null;
    }

    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

    return `linux:${bootId}:${startTime}`;
  } catch {
    return null;
  }
};

/**
 * What the process holding `pid` is running, from `/proc/<pid>/cmdline`, or
 * `null` where that cannot be read.
 *
 * This exists for one question the re-audit (R-1) forced into the open: when
 * a lock cannot be parsed, is the pid recorded elsewhere a *campaign*, or an
 * unrelated program that happens to hold a recycled pid? Liveness alone
 * cannot say, and guessing in either direction is unsafe — guess "campaign"
 * and a dead campaign wedges the repository forever; guess "unrelated" and
 * two campaigns mutate the same files.
 */
export const processCommand = (pid) => {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
      .split('\0')
      .join(' ')
      .trim();
  } catch {
    return null;
  }
};

/** Does that pid belong to a mutation campaign? `null` when it cannot be told. */
export const processIsCampaign = (pid, command = processCommand) => {
  const line = command(pid);

  if (line === null || line.length === 0) {
    return null;
  }

  return line.includes('mutation-test.mjs');
};

/** A lock file as it actually is on disk: present or not, parseable or not. */
export const readLockFile = (path) => {
  let contents;

  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, readable: true, record: null };
    }

    // A lock file that exists but cannot be read is emphatically not "no
    // lock": that is the reading that let the runner walk into a campaign.
    return { exists: true, readable: false, record: null };
  }

  try {
    return { exists: true, readable: true, record: JSON.parse(contents) };
  } catch {
    return { exists: true, readable: true, record: null };
  }
};

/**
 * What the lock on disk means right now.
 *
 * `absent`        — no lock file exists. Only this means "no campaign".
 * `malformed`     — a lock file exists but is not a usable lock record:
 *                   unreadable, not JSON, or missing the fields a lock must
 *                   have. Fails closed; it is **not** treated as absent.
 *                   (Audit D-2: `null` from a corrupt file used to be
 *                   classified `absent`, and the caller then dereferenced it.)
 * `live`          — its owner is running and is the same process that took
 *                   it. Never bypassed, not even with --force.
 * `stale`         — its owner is gone, or the pid is now held by a different
 *                   process than the one that took the lock. Takeable, after
 *                   any recovery state has been settled.
 * `indeterminate` — the owner is alive but this platform cannot prove whether
 *                   it is the original holder. Never silently taken over.
 * `self`          — this very process holds it.
 *
 * `exists` distinguishes "no file" from "a file that did not parse"; it
 * defaults to "a record was supplied", so a caller that has already parsed a
 * record keeps the obvious behaviour.
 */
export const classifyLock = ({
  record,
  pid,
  isAlive = processAlive,
  exists = record !== null && record !== undefined,
  identityOf = ownerIdentity,
}) => {
  if (record === null || record === undefined) {
    return exists ? 'malformed' : 'absent';
  }

  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    return 'malformed';
  }

  if (typeof record.secretDigest !== 'string' || record.secretDigest.length === 0) {
    return 'malformed';
  }

  if (record.pid === pid) {
    return 'self';
  }

  if (!isAlive(record.pid)) {
    return 'stale';
  }

  const current = identityOf(record.pid);

  if (typeof record.owner === 'string' && record.owner.length > 0 && current !== null) {
    // Alive, but is it the same process? A recycled pid is as dead as a dead
    // one for our purposes, and much more dangerous, because it looks alive.
    return current === record.owner ? 'live' : 'stale';
  }

  // Either the lock predates owner identities or the platform cannot supply
  // one. Something is running under that pid and we cannot say what it is.
  return 'indeterminate';
};

/**
 * Is this process an authorised child of the campaign that holds the lock?
 *
 * Both halves are required and neither is guessable from the lock file: the
 * secret is never written down, and the pid in the environment must match the
 * pid that owns the lock, which must itself still be alive. An unrelated test
 * process that copies the lock's digest into the environment fails, because
 * the digest is not the secret.
 */
export const isAuthorisedSubprocess = ({
  record,
  env,
  isAlive = processAlive,
  identityOf = ownerIdentity,
}) => {
  if (record === null || record === undefined) {
    return false;
  }

  const declaredPid = Number.parseInt(env[AUTHORISATION_ENV.pid] ?? '', 10);
  const secret = env[AUTHORISATION_ENV.secret] ?? '';

  if (!Number.isInteger(declaredPid) || declaredPid !== record.pid) {
    return false;
  }

  if (typeof record.secretDigest !== 'string' || secret.length === 0) {
    return false;
  }

  if (!isAlive(record.pid)) {
    return false;
  }

  // The pid is alive — but if it is alive as a *different* process than the
  // one that took the lock, this cannot be that campaign's child (D-5).
  if (typeof record.owner === 'string' && record.owner.length > 0) {
    const current = identityOf(record.pid);

    if (current !== null && current !== record.owner) {
      return false;
    }
  }

  return digestsMatch(sha256(secret), record.secretDigest);
};

/**
 * The decision an ordinary test run makes before it loads a single test file.
 *
 * Returns `{ allowed, reason, message }`. The message is written for someone
 * who is looking at a red suite and does not yet know why.
 */
export const interlockDecision = ({
  record,
  env,
  pid,
  isAlive = processAlive,
  identityOf = ownerIdentity,
  lockFile,
  exists,
  recovery = { action: 'none' },
  marker = { exists: false, record: null },
}) => {
  const state = classifyLock({ record, pid, isAlive, exists, identityOf });

  // The campaign's own test subprocesses come first: they run *while* the
  // lock is live and the marker says `mutating`, which is every blocking
  // condition below at once. Their authorisation is owner-bound and
  // secret-bound, so nothing else can take this exit.
  if (isAuthorisedSubprocess({ record, env, isAlive, identityOf })) {
    return { allowed: true, reason: 'authorised-subprocess', message: '' };
  }

  if (state === 'self') {
    return { allowed: true, reason: state, message: '' };
  }

  if (state === 'live') {
    return {
      allowed: false,
      reason: 'live-campaign',
      message:
        `a mutation campaign is running (pid ${String(record.pid)}, started ${String(
          record.startedAt,
        )}).\n` +
        'It plants deliberate faults in production source and takes them out again,\n' +
        'so a suite started now would read a mutated file and report failures that\n' +
        'are not real. This run has been stopped before any test file was loaded.\n\n' +
        'Wait for the campaign to finish and run the suite again. If you are certain\n' +
        'the campaign is gone, run `node scripts/mutation-test.mjs --recover`, which\n' +
        'restores any half-applied mutant and clears the lock.\n' +
        `(lock: ${String(lockFile)})`,
    };
  }

  if (state === 'indeterminate') {
    return {
      allowed: false,
      reason: 'indeterminate-owner',
      message:
        `a mutation campaign lock is held by pid ${String(record.pid)}, which is running —\n` +
        'but this platform cannot confirm whether that is still the campaign that took\n' +
        'the lock or an unrelated process that was given the same pid. The suite is not\n' +
        'started, because if it is the campaign, every failure reported would be false.\n\n' +
        'Run `node scripts/mutation-test.mjs --recover` to settle any interrupted work.\n' +
        'Note that --force does not override uncertain ownership: if no campaign is\n' +
        'running, the way out is to establish that — stop the process holding that pid,\n' +
        'or let it finish — after which recovery proceeds by itself.\n' +
        `(lock: ${String(lockFile)})`,
    };
  }

  /*
   * No live owner — but recovery state can still mean the tree is not the
   * tree in Git, and a suite run against a planted fault reports a
   * regression that is not there. That is G1, the failure this whole slice
   * exists for, and before the D-1 remediation it was reachable simply by
   * deleting `node_modules` after a kill.
   */
  if (recovery.action === 'recover') {
    return {
      allowed: false,
      reason: 'recovery-required',
      message:
        'an earlier mutation campaign did not finish, and its recovery journal is still\n' +
        'on disk. Production source may be holding a planted fault right now, so this\n' +
        'run has been stopped before any test file was loaded.\n\n' +
        'Run `node scripts/mutation-test.mjs --recover`. It restores every journalled\n' +
        'file, verifies the bytes it writes, and refuses rather than overwriting\n' +
        'anything it does not recognise.',
    };
  }

  if (recovery.action === 'refuse') {
    return {
      allowed: false,
      reason: 'recovery-inconsistent',
      message:
        `MUTATION RECOVERY STATE IS INCONSISTENT\n\n${recovery.message}\n\n` +
        'The suite has not been started: its results could not be trusted until this\n' +
        'is resolved.',
    };
  }

  /*
   * A lock that exists but cannot be read is not an absent lock.
   *
   * The runner learned this in the R-1 remediation; the interlock had not.
   * It fell through to `allowed` for `malformed`, so corrupting a running
   * campaign's lock let an ordinary suite start against a tree that was
   * being rewritten — the same defect, one layer up. An unreadable lock,
   * or a marker that still names a live owner, now stops the suite.
   */
  const ownership = resolveOwnership({
    lock: { exists, record },
    marker,
    pid,
    isAlive,
    identityOf,
  });

  if (state === 'malformed' || ownership.state === 'live' || ownership.state === 'indeterminate') {
    return {
      allowed: false,
      reason: state === 'malformed' ? 'malformed-lock' : `owner-${ownership.state}`,
      message:
        'a mutation campaign lock is present but this run cannot establish who owns it\n' +
        `(${state === 'malformed' ? 'the lock file cannot be read' : ownership.evidence}).\n\n` +
        'An unreadable or unresolvable lock is not an absent one: if a campaign is\n' +
        'running, every failure this suite reported would be false, so it has been\n' +
        'stopped before any test file was loaded.\n\n' +
        'If a campaign is running, wait for it. If none is, run\n' +
        '`node scripts/mutation-test.mjs --recover` to settle and clear the state.\n' +
        `(lock: ${String(lockFile)})`,
    };
  }

  return { allowed: true, reason: state, message: '' };
};

/* ------------------------------------------------------------------ *
 * Durable writes
 * ------------------------------------------------------------------ */

const syncDirectory = (directory) => {
  // Not portable: a directory cannot be opened for sync on every platform.
  // Best effort, exactly as the reader-state store does it (ADR-016).
  try {
    const handle = openSync(directory, 'r');

    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    /* the rename still happened; this only narrows the power-loss window */
  }
};

/**
 * Write that is never seen half-finished: temporary file, flushed, renamed
 * over the target. Used for the journal *and* for source files, so a campaign
 * killed mid-write can never leave a syntactically broken production file.
 */
export const writeFileDurably = (path, contents, { mode } = {}) => {
  const temporary = `${path}.mutation-tmp`;
  const handle = openSync(temporary, 'w');

  try {
    writeFileSync(handle, contents);

    /*
     * The mode is set on the *temporary* file, before the rename, so the
     * file never exists at its real path with the wrong permissions — and
     * so that restoration is faithful rather than umask-flavoured. The audit
     * (D-3) measured a 0755 source file coming back 0644, which is a silent
     * change to a tracked file's metadata.
     */
    if (typeof mode === 'number') {
      fchmodSync(handle, mode & 0o7777);
    }

    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }

  renameSync(temporary, path);
  syncDirectory(dirname(path));
};

/** The permission bits of an existing file, or `undefined` if it has none to read. */
export const fileMode = (path) => {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
};

/* ------------------------------------------------------------------ *
 * The recovery journal
 * ------------------------------------------------------------------ */

export const JOURNAL_VERSION = 1;

export const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * A journalled path must be repository-relative and stay inside the
 * repository. A journal is a list of files something else is about to
 * overwrite; it is exactly the wrong place to trust a path.
 */
export const isOwnedPath = (projectRoot, candidate) => {
  if (typeof candidate !== 'string' || candidate.length === 0 || isAbsolute(candidate)) {
    return false;
  }

  const resolved = resolve(projectRoot, candidate);
  const within = relative(projectRoot, resolved);

  return within.length > 0 && !within.startsWith('..') && !within.startsWith(`${sep}..`);
};

/**
 * Records, durably, what is about to be done — before a single source byte
 * changes. Each entry keeps the original contents in a blob named after their
 * own digest, so a half-written blob cannot be mistaken for a good one.
 */
export const writeJournal = ({ projectRoot, mutantId, pid, entries }) => {
  const paths = campaignPaths(projectRoot);

  mkdirSync(paths.journalDirectory, { recursive: true });

  const journalEntries = entries.map((entry) => {
    const originalDigest = sha256(entry.original);
    const blob = join(paths.journalDirectory, `${originalDigest}.original`);

    writeFileDurably(blob, entry.original);

    return {
      file: entry.file,
      originalDigest,
      mutatedDigest: sha256(entry.mutated),
      // Captured before the file is touched, restored with the bytes (D-3).
      mode: entry.mode ?? fileMode(resolve(projectRoot, entry.file)),
      blob: relative(projectRoot, blob),
    };
  });

  writeFileDurably(
    paths.journalFile,
    `${JSON.stringify(
      {
        version: JOURNAL_VERSION,
        pid,
        mutantId,
        startedAt: new Date().toISOString(),
        entries: journalEntries,
      },
      null,
      2,
    )}\n`,
  );

  return journalEntries;
};

/** Clears the journal and its blobs. Only ever called after a verified restore. */
export const clearJournal = (projectRoot) => {
  const paths = campaignPaths(projectRoot);

  rmSync(paths.journalFile, { force: true });
  rmSync(paths.journalDirectory, { recursive: true, force: true });
};

/**
 * Finishes an interrupted transaction.
 *
 * For every journalled file, exactly one of four things is true:
 *
 * - it already holds the original bytes → nothing to do (this is what makes
 *   recovery safe to repeat: an interrupted recovery leaves some entries done
 *   and some not, and a second attempt simply skips the done ones);
 * - it holds the mutant → restore it from the blob, verifying the blob's own
 *   digest first, and write it durably;
 * - it holds something else → **refuse**, loudly, and touch nothing. That file
 *   has been edited by someone, and the campaign has no claim on it;
 * - the path is not one the campaign could own → refuse.
 *
 * Returns `{ ok, restored, skipped, refused, details }`. The journal is the
 * caller's to clear, and only when `ok` is true.
 */
export const recoverJournal = ({ projectRoot, journal, readFile = readFileSync }) => {
  const restored = [];
  const skipped = [];
  const refused = [];
  const details = [];

  if (journal === null || journal === undefined) {
    return { ok: true, restored, skipped, refused, details };
  }

  if (journal.version !== JOURNAL_VERSION || !Array.isArray(journal.entries)) {
    return {
      ok: false,
      restored,
      skipped,
      refused,
      details: [`the journal is not a version ${String(JOURNAL_VERSION)} record`],
    };
  }

  for (const entry of journal.entries) {
    if (!isOwnedPath(projectRoot, entry.file) || !isOwnedPath(projectRoot, entry.blob)) {
      refused.push(String(entry.file));
      details.push(`${String(entry.file)}: not a path this campaign can own`);
      continue;
    }

    const target = resolve(projectRoot, entry.file);

    let current;

    try {
      current = readFile(target, 'utf8');
    } catch (error) {
      refused.push(entry.file);
      details.push(`${entry.file}: cannot be read (${String(error.code ?? error)})`);
      continue;
    }

    const currentDigest = sha256(current);

    if (currentDigest === entry.originalDigest) {
      if (typeof entry.mode === 'number' && fileMode(target) !== (entry.mode & 0o7777)) {
        // The bytes are right but the permissions are not: a restore that
        // was interrupted between the write and the chmod, or an earlier
        // version of this harness. Put them back too.
        chmodSync(target, entry.mode & 0o7777);
        details.push(`${entry.file}: already the original, permissions restored`);
        restored.push(entry.file);
        continue;
      }

      skipped.push(entry.file);
      details.push(`${entry.file}: already the original`);
      continue;
    }

    if (currentDigest !== entry.mutatedDigest) {
      refused.push(entry.file);
      details.push(
        `${entry.file}: on disk it is neither the mutant this campaign planted nor the ` +
          'original it recorded, so it has been changed by something else — refusing to ' +
          'overwrite it',
      );
      continue;
    }

    let original;

    try {
      original = readFile(resolve(projectRoot, entry.blob), 'utf8');
    } catch (error) {
      refused.push(entry.file);
      details.push(
        `${entry.file}: its recorded original is unreadable (${String(error.code ?? error)})`,
      );
      continue;
    }

    if (sha256(original) !== entry.originalDigest) {
      refused.push(entry.file);
      details.push(`${entry.file}: its recorded original does not match its digest`);
      continue;
    }

    writeFileDurably(target, original, { mode: entry.mode });

    const verified = sha256(readFile(target, 'utf8'));

    if (verified !== entry.originalDigest) {
      refused.push(entry.file);
      details.push(`${entry.file}: the restored bytes do not match the recorded digest`);
      continue;
    }

    if (typeof entry.mode === 'number' && fileMode(target) !== (entry.mode & 0o7777)) {
      refused.push(entry.file);
      details.push(`${entry.file}: the restored permissions do not match the recorded mode`);
      continue;
    }

    restored.push(entry.file);
    details.push(`${entry.file}: restored from the journal`);
  }

  return { ok: refused.length === 0, restored, skipped, refused, details };
};

/** Any `.mutation-tmp` left behind by a kill between write and rename. */
export const sweepTemporaries = (projectRoot, journal) => {
  const swept = [];

  if (journal === null || journal === undefined || !Array.isArray(journal.entries)) {
    return swept;
  }

  for (const entry of journal.entries) {
    if (!isOwnedPath(projectRoot, entry.file)) {
      continue;
    }

    const temporary = `${resolve(projectRoot, entry.file)}.mutation-tmp`;

    try {
      rmSync(temporary, { force: true });
      swept.push(entry.file);
    } catch {
      /* nothing to sweep */
    }
  }

  return swept;
};

/** Blobs no longer referenced by the journal, removed after a clean campaign. */
export const orphanBlobs = (projectRoot) => {
  const paths = campaignPaths(projectRoot);

  try {
    return readdirSync(paths.journalDirectory);
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ *
 * The interrupted-campaign marker
 * ------------------------------------------------------------------ */

/**
 * Why a marker exists at all, when there is already a journal.
 *
 * Because the absence of a journal is ambiguous, and the audit (D-1) showed
 * exactly how that ambiguity ends: journal deleted, source still mutated,
 * `--recover` exits 0 saying "nothing further to do". A journal can only ever
 * say "here is what to put back"; it can never say "something was going on
 * here and its record is missing".
 *
 * The marker is that second statement. It is written when a campaign takes
 * the lock and removed only when the campaign has finished and left the tree
 * as it found it, so marker-without-journal is a *detectable* state rather
 * than an invisible one. Its `phase` says how far the campaign had got:
 *
 * - `started`  — the lock is held, no source has been mutated. The journal is
 *                legitimately absent in this phase.
 * - `mutating` — a journal is durable and source files either are, or are
 *                about to be, mutated. A missing journal here is an
 *                inconsistency and is refused, never finalised.
 * - `restored` — the files have been written back and verified; only cleanup
 *                remained. Safe to finalise.
 *
 * In `mutating` the marker also carries the digests of the files involved —
 * the same digests the journal carries. They are duplicated deliberately:
 * if the journal is lost, the digests are still enough to *prove* whether
 * the tree is mutated, which turns "we cannot know" into either "this file
 * is mutated, here is its name" or "every file is its original".
 */
export const MARKER_VERSION = 2;

export const writeMarker = ({ projectRoot, pid, owner, phase, mutantId = null, files = [] }) => {
  const paths = campaignPaths(projectRoot);

  mkdirSync(paths.stateDirectory, { recursive: true });

  writeFileDurably(
    paths.markerFile,
    `${JSON.stringify(
      {
        version: MARKER_VERSION,
        pid,
        owner,
        phase,
        mutantId,
        files,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
};

export const clearMarker = (projectRoot) => {
  rmSync(campaignPaths(projectRoot).markerFile, { force: true });
};

export const readMarkerFile = (path) => {
  if (!existsSync(path)) {
    return { exists: false, record: null };
  }

  return { exists: true, record: readJsonFile(path) };
};

const PHASES = new Set(['started', 'mutating', 'restored']);

const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * A marker's file list is evidence or it is nothing.
 *
 * The re-audit cleared outstanding state for a marker whose list was empty
 * (R-2) and finalised a `restored` marker that carried no list at all
 * (R-3) — both announcing that "every file matches its original digest"
 * after inspecting no files. An empty list, a non-array, an entry with a
 * path this campaign could not own, or a missing 64-hex original digest are
 * all *insufficient evidence*, which is a refusal and never a pass.
 */
export const markerFileList = (projectRoot, files) => {
  if (!Array.isArray(files)) {
    return { usable: false, reason: 'the marker file list is not a list', entries: [] };
  }

  if (files.length === 0) {
    return { usable: false, reason: 'the marker recorded no files', entries: [] };
  }

  for (const entry of files) {
    if (entry === null || typeof entry !== 'object') {
      return {
        usable: false,
        reason: 'the marker file list contains something that is not an entry',
        entries: [],
      };
    }

    if (!isOwnedPath(projectRoot, entry.file)) {
      return {
        usable: false,
        reason: `the marker names a path this campaign cannot own (${String(entry.file)})`,
        entries: [],
      };
    }

    if (!DIGEST.test(String(entry.originalDigest))) {
      return {
        usable: false,
        reason: `the marker has no usable original digest for ${String(entry.file)}`,
        entries: [],
      };
    }
  }

  return { usable: true, reason: '', entries: files };
};

/**
 * Checks every recorded file against the identity the marker kept for it:
 * the original bytes' digest, and the permission bits where one was
 * recorded. This is the only thing allowed to justify discarding state that
 * has no journal behind it.
 */
export const verifyAgainstMarker = ({
  projectRoot,
  entries,
  readFile = readFileSync,
  modeOf = fileMode,
}) =>
  entries.map((entry) => {
    const target = resolve(projectRoot, entry.file);

    let current;

    try {
      current = sha256(readFile(target, 'utf8'));
    } catch {
      return { file: entry.file, state: 'unreadable' };
    }

    if (current !== entry.originalDigest) {
      return { file: entry.file, state: current === entry.mutatedDigest ? 'mutated' : 'changed' };
    }

    if (typeof entry.mode === 'number' && modeOf(target) !== (entry.mode & 0o7777)) {
      return { file: entry.file, state: 'wrong-mode' };
    }

    return { file: entry.file, state: 'original' };
  });

/**
 * What the recovery state on disk requires of whoever found it.
 *
 * Returns `{ action, reason, message, journal, marker }` where `action` is
 * one of:
 *
 * - `none`      — nothing was interrupted.
 * - `recover`   — a journal describes work to finish. Must be run before any
 *                 control test, and before a new campaign starts.
 * - `finalise`  — there is a marker but demonstrably nothing to put back
 *                 (the campaign never mutated anything, or had already
 *                 restored and verified everything). Clearing it is safe.
 * - `refuse`    — the state is inconsistent: the tree may be mutated and the
 *                 means to put it back are missing or unusable. **Never
 *                 reported as success.**
 *
 * `refuse` is the state the audit produced and the runner did not have.
 */
export const assessRecovery = ({
  projectRoot = defaultProjectRoot,
  readFile = readFileSync,
} = {}) => {
  const paths = campaignPaths(projectRoot);
  const marker = readMarkerFile(paths.markerFile);
  const journalExists = existsSync(paths.journalFile);
  const journal = journalExists ? readJsonFile(paths.journalFile) : null;
  const journalUsable =
    journal !== null && journal.version === JOURNAL_VERSION && Array.isArray(journal.entries);

  const base = { journal, marker: marker.record, journalExists };

  if (journalExists && !journalUsable) {
    return {
      ...base,
      action: 'refuse',
      reason: 'journal-unusable',
      message:
        `the recovery journal exists but cannot be used (${paths.journalFile}).\n` +
        'It is not a journal this version understands, so it cannot be replayed and\n' +
        'the working tree may still hold a planted fault. Nothing has been changed.',
    };
  }

  if (!marker.exists) {
    if (journalUsable) {
      // A journal with no marker: older state, or a marker lost on its own.
      // The journal is the authoritative record of work to finish.
      return { ...base, action: 'recover', reason: 'journal-without-marker', message: '' };
    }

    return { ...base, action: 'none', reason: 'nothing-interrupted', message: '' };
  }

  const record = marker.record;

  if (record === null || record.version !== MARKER_VERSION || !PHASES.has(record.phase)) {
    if (journalUsable) {
      return {
        ...base,
        action: 'recover',
        reason: 'marker-unreadable-journal-usable',
        message: '',
      };
    }

    return {
      ...base,
      action: 'refuse',
      reason: 'marker-unreadable',
      message:
        `a campaign left a marker that cannot be read (${paths.markerFile}),\n` +
        'and there is no journal to fall back on. Whether a planted fault is still in\n' +
        'the working tree cannot be established from here. Nothing has been changed.',
    };
  }

  if (journalUsable) {
    // Any phase with a usable journal: replay it. `restored` simply finds
    // every entry already correct and skips it.
    return { ...base, action: 'recover', reason: `${record.phase}-with-journal`, message: '' };
  }

  if (record.phase === 'started') {
    /*
     * `started` is written in exactly two places: when the lock is taken,
     * and again after a restore has been verified and its journal cleared.
     * Journal durability strictly precedes the first mutated byte, so this
     * phase with no journal means nothing was mutated under it. It is the
     * one state that may be finalised without file-by-file evidence, and
     * that rests on the write ordering, not on an assumption.
     */
    return {
      ...base,
      action: 'finalise',
      reason: 'started-never-mutated',
      message: 'an earlier campaign took the lock and was interrupted before it mutated anything.',
    };
  }

  /*
   * `mutating` and `restored` both mean source files were in this
   * campaign's hands. Neither phase is proof of anything by itself (R-3):
   * the identities the marker recorded are checked file by file before any
   * of this is cleared.
   */
  const list = markerFileList(projectRoot, record.files);

  if (!list.usable) {
    return {
      ...base,
      action: 'refuse',
      reason: 'marker-file-list-unusable',
      message:
        `an earlier campaign was interrupted at the "${record.phase}" stage, its recovery\n` +
        `journal is gone, and ${list.reason}. There is nothing left to check the working\n` +
        'tree against, so whether a planted fault is still in it cannot be established\n' +
        'from here. Nothing has been changed.\n\n' +
        'Inspect the working tree against version control (`git status --short -- src`,\n' +
        '`git diff -- src`), restore anything a campaign left behind, and then remove\n' +
        `${STATE_DIRECTORY}/ by hand once you have established the tree is what you want.`,
    };
  }

  const verdicts = verifyAgainstMarker({ projectRoot, entries: list.entries, readFile });
  const notOriginal = verdicts.filter((entry) => entry.state !== 'original');

  if (notOriginal.length === 0) {
    return {
      ...base,
      verdicts,
      action: 'finalise',
      reason:
        record.phase === 'restored'
          ? 'restored-and-verified-against-the-marker'
          : 'journal-missing-tree-proven-clean',
      message:
        `an earlier campaign was interrupted at the "${record.phase}" stage and its journal\n` +
        `is gone, but every one of the ${String(verdicts.length)} file(s) it recorded matches the original\n` +
        'digest and permissions the marker kept, so the working tree is provably as the\n' +
        'campaign found it.',
    };
  }

  if (record.phase === 'restored') {
    return {
      ...base,
      verdicts,
      action: 'refuse',
      reason: 'restored-but-not-restored',
      message:
        'a marker says an earlier campaign had restored its files, but they are not the\n' +
        'originals it recorded:\n' +
        `${notOriginal.map((entry) => `  · ${entry.file} (${entry.state})`).join('\n')}\n\n` +
        'The marker is not telling the truth about the working tree and its journal is\n' +
        'gone. Nothing has been changed. Restore these files from version control\n' +
        '(`git restore <file>`), then run\n' +
        '  node scripts/mutation-test.mjs --clear-recovery-state',
    };
  }

  return {
    ...base,
    verdicts,
    action: 'refuse',
    reason: 'journal-missing',
    message:
      'an earlier campaign was interrupted while it had mutated production source, and\n' +
      'its recovery journal is missing. Automatic recovery cannot be guaranteed: the\n' +
      'original bytes were kept with the journal and are gone with it.\n\n' +
      `These files are not the originals the marker recorded:\n${notOriginal
        .map((entry) => `  · ${entry.file} (${entry.state})`)
        .join('\n')}\n\n` +
      'Put them back from version control (`git diff -- src`, `git restore <file>`),\n' +
      'then clear the recovery state with\n' +
      '  node scripts/mutation-test.mjs --clear-recovery-state\n' +
      'which refuses unless every file the marker recorded verifies first.',
  };
};

/* ------------------------------------------------------------------ *
 * Who owns the campaign right now
 * ------------------------------------------------------------------ */

/**
 * The single question every state-destroying path must ask *first*.
 *
 * The re-audit of `53b2358` (R-1) reproduced a single-writer violation that
 * came entirely from asking it too late. `recoverInterrupted()` guarded the
 * `live` and `indeterminate` lock states and let `malformed` fall through
 * into finalisation — which clears the marker, the journal and the lock. A
 * live campaign whose lock file had been corrupted therefore had its own
 * recovery evidence deleted by the next invocation, after which
 * `acquireLock()` found no lock at all and its malformed-lock guard could
 * not fire. Two campaigns then mutated the same files, and the intruder
 * restored the live campaign's in-flight mutation underneath it.
 *
 * The correction is not another guard in another place: it is that
 * ownership is resolved from *all* the evidence, before anything is
 * touched, and that an unparseable lock makes the answer **less** certain
 * rather than more. The marker is independent of the lock — written by the
 * campaign, carrying its pid and owner identity — so when the lock is
 * unreadable the marker is consulted, and when neither can answer the
 * result is `indeterminate`, which no flag overrides.
 *
 * Returns `{ state, pid, owner, source, evidence }` with `state` one of:
 *
 * - `none`          — no lock, no marker. Nobody owns anything.
 * - `self`          — this process.
 * - `live`          — a campaign is running. Never bypassed, not by --force.
 * - `stale`         — the owner is conclusively gone: its pid is dead, or
 *                     the pid is alive but is demonstrably a different
 *                     process (start-time identity differs, or `/proc` shows
 *                     it is not a campaign at all). Takeover is safe.
 * - `indeterminate` — the evidence does not establish either. Fail closed.
 */
export const resolveOwnership = ({
  lock,
  marker,
  pid,
  isAlive = processAlive,
  identityOf = ownerIdentity,
  isCampaign = processIsCampaign,
}) => {
  const claims = [];

  const judge = (record, source) => {
    if (record === null || record === undefined) {
      return;
    }

    const claimedPid = record.pid;

    if (typeof claimedPid !== 'number' || !Number.isInteger(claimedPid) || claimedPid <= 0) {
      // A record that exists but names no usable owner is uncertainty, not
      // proof that nobody owns this (requirement 4).
      claims.push({
        state: 'indeterminate',
        pid: null,
        owner: null,
        source,
        evidence: 'no usable pid',
      });
      return;
    }

    if (claimedPid === pid) {
      claims.push({
        state: 'self',
        pid: claimedPid,
        owner: record.owner ?? null,
        source,
        evidence: 'this process',
      });
      return;
    }

    if (!isAlive(claimedPid)) {
      claims.push({
        state: 'stale',
        pid: claimedPid,
        owner: record.owner ?? null,
        source,
        evidence: 'the process is gone',
      });
      return;
    }

    const current = identityOf(claimedPid);

    if (typeof record.owner === 'string' && record.owner.length > 0 && current !== null) {
      claims.push(
        current === record.owner
          ? {
              state: 'live',
              pid: claimedPid,
              owner: record.owner,
              source,
              evidence: 'owner identity matches',
            }
          : {
              state: 'stale',
              pid: claimedPid,
              owner: record.owner,
              source,
              evidence: 'the pid now belongs to a different process',
            },
      );
      return;
    }

    /*
     * No identity to compare — an older record, or a platform without
     * `/proc`. One question can still settle it on Linux: is the process
     * holding that pid a mutation campaign at all? A definite "no" means
     * the original owner is gone and its pid was recycled, which is safe to
     * take over. A definite "yes" is live. No answer is `indeterminate`,
     * and --force does not override it.
     */
    const campaign = isCampaign(claimedPid);

    if (campaign === true) {
      claims.push({
        state: 'live',
        pid: claimedPid,
        owner: null,
        source,
        evidence: 'that pid is running a mutation campaign',
      });
      return;
    }

    if (campaign === false) {
      claims.push({
        state: 'stale',
        pid: claimedPid,
        owner: null,
        source,
        evidence: 'that pid is running something that is not a mutation campaign',
      });
      return;
    }

    claims.push({
      state: 'indeterminate',
      pid: claimedPid,
      owner: null,
      source,
      evidence: 'the owner of that pid cannot be established',
    });
  };

  judge(lock.record, 'lock');
  judge(marker.record, 'marker');

  /*
   * A lock or marker file that exists but could not be parsed is evidence
   * that *something* was here, and nothing else. It can never make the
   * answer safer, so it contributes uncertainty.
   */
  if (lock.exists && lock.record === null) {
    claims.push({
      state: 'indeterminate',
      pid: null,
      owner: null,
      source: 'lock',
      evidence: 'the lock file cannot be read',
    });
  }

  if (marker.exists && marker.record === null) {
    claims.push({
      state: 'indeterminate',
      pid: null,
      owner: null,
      source: 'marker',
      evidence: 'the marker cannot be read',
    });
  }

  if (claims.length === 0) {
    return {
      state: 'none',
      pid: null,
      owner: null,
      source: null,
      evidence: 'no lock and no marker',
    };
  }

  // Any evidence of a live owner outranks everything else, always.
  const live = claims.find((entry) => entry.state === 'live');

  if (live !== undefined) {
    return live;
  }

  /*
   * A file that exists but cannot be parsed says "something was here" and
   * carries no pid, so on its own it is uncertainty. It must not, however,
   * outrank an intact record that positively settles the question: the lock
   * and the marker are written independently, and the whole point of the
   * marker is to survive the lock being damaged. When a readable record
   * names an owner and that owner is conclusively gone, the state is stale
   * and recovery-first startup goes ahead — which is what keeps a corrupt
   * lock from stranding the tree permanently.
   */
  const determinate = claims.find(
    (entry) => entry.pid !== null && (entry.state === 'self' || entry.state === 'stale'),
  );

  if (determinate !== undefined) {
    return determinate;
  }

  // Nothing positively settles it; uncertainty outranks "safe to take".
  for (const state of ['indeterminate', 'self', 'stale']) {
    const claim = claims.find((entry) => entry.state === state);

    if (claim !== undefined) {
      return claim;
    }
  }

  return {
    state: 'indeterminate',
    pid: null,
    owner: null,
    source: null,
    evidence: 'unclassifiable',
  };
};

/**
 * An exclusive claim over the recovery state, held for the whole of a
 * destructive operation, and transferred by creating a *new* claim rather
 * than by deleting an old one.
 *
 * The third audit's blocking finding B-1: `resolveOwnership()` answers
 * "who owns this?" correctly, but answering it is not the same as holding
 * it. Two processes could both see the same *stale* owner, both pass the
 * check and both begin recovering. The claim closes that: it is created
 * with `wx`, so the kernel picks exactly one winner among any number of
 * simultaneous contenders, and it is held across restoration *and*
 * cleanup rather than merely tested beforehand.
 *
 * The fourth audit's blocking finding B-1: the previous reclamation was a
 * read-compare-unlink sequence. It re-read the claim's bytes immediately
 * before the unlink and abandoned the steal if they had changed, but the
 * unlink itself named a *path*, not the bytes that had been inspected. A
 * contender that replaced the claim between the comparison and the unlink
 * had its brand-new, live claim deleted by the loser, which then created
 * its own — leaving two processes each believing they held the state. The
 * audit reproduced it without instrumentation: 9 of 40 two-process rounds
 * and 10 of 30 four-process rounds ended with more than one holder, and
 * 6 of 20 concurrent `--recover` pairs collided inside `recoverJournal()`
 * with an `ENOENT` on the same file's atomic rename.
 *
 * Narrowing that window cannot close it, so the protocol no longer has
 * one. Claims are *generation numbered*: generation 0 is `campaign.claim`
 * and generation N is `campaign.claim.gN`. The holder of the state is
 * whoever owns the highest-numbered claim that exists. Taking over from a
 * dead holder at generation N means creating generation N + 1 with
 * `wx` — an atomic create-if-absent, so the kernel picks exactly one
 * winner among any number of contenders, exactly as it does for the
 * uncontended case.
 *
 * The consequence that matters: *acquiring ownership never removes a file*.
 * A loser cannot revoke a winner's claim because losing is an `EEXIST`
 * from its own create, not a failed comparison before someone else's
 * delete. Deletion happens only in two places, both conditional on the
 * bytes at the moment of deletion: a holder releasing its own claim, and a
 * winner sweeping generations strictly below its own, which are
 * superseded by construction.
 */
export const CLAIM_VERSION = 1;

/** Generation 0 keeps the plain name so the common case is readable. */
const claimGenerationPath = (paths, generation) =>
  generation === 0 ? paths.claimFile : `${paths.claimFile}.g${String(generation)}`;

const CLAIM_GENERATION_PATTERN = /^campaign\.claim(?:\.g(\d+))?$/u;

/**
 * Every claim file present, lowest generation first. Reading this is not
 * atomic and does not need to be: it only ever decides which generation to
 * *attempt*, and the attempt itself is the atomic test.
 */
const listClaimGenerations = (paths, readDirectory = readdirSync) => {
  let names;

  try {
    names = readDirectory(paths.stateDirectory);
  } catch {
    return [];
  }

  const found = [];

  for (const name of names) {
    const match = CLAIM_GENERATION_PATTERN.exec(name);

    if (match) {
      found.push({
        generation: match[1] === undefined ? 0 : Number(match[1]),
        path: join(paths.stateDirectory, name),
      });
    }
  }

  return found.sort((a, b) => a.generation - b.generation);
};

/** The highest generation that exists: the current owner of the state. */
const currentClaim = (paths, readFile = readFileSync) => {
  const generations = listClaimGenerations(paths);

  if (generations.length === 0) {
    return null;
  }

  const highest = generations[generations.length - 1];
  let bytes;

  try {
    bytes = readFile(highest.path);
  } catch {
    // It went away underneath us; the caller re-reads on the next attempt.
    return null;
  }

  let record;

  try {
    record = JSON.parse(bytes.toString());
  } catch {
    // Unparsable: the caller treats it as a claim it may not supersede.
    record = null;
  }

  return { ...highest, bytes, record };
};

/**
 * Whether the holder of a claim is still running. A record we cannot parse,
 * or one without a usable pid, is `unreadable` — not ours to supersede.
 */
const claimHolderState = (record, isAlive, identityOf) => {
  const pid = record?.pid;

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return 'unreadable';
  }

  if (!isAlive(pid)) {
    return 'dead';
  }

  const current = identityOf(pid);

  if (typeof record.owner !== 'string' || current === null || current === record.owner) {
    // Running, and either the same process or no way to tell. Both mean
    // this claim is not available.
    return 'alive';
  }

  // The pid is in use by something that started at a different time: the
  // claim's holder is gone and the number has been recycled.
  return 'dead';
};

/**
 * Reads one specific claim generation, returning both the bytes seen and
 * the record they parse to. `null` means the file is gone, unreadable or
 * unparsable — three cases a caller must never treat as "nobody is there".
 */
const readClaimAt = (path, readFile = readFileSync) => {
  let bytes;

  try {
    bytes = readFile(path);
  } catch {
    return null;
  }

  try {
    return { bytes, record: JSON.parse(bytes.toString()) };
  } catch {
    return { bytes, record: null };
  }
};

/**
 * Removes a file only if its contents are still exactly what the caller
 * inspected. This is the only form of claim deletion in the protocol.
 */
const removeIfUnchanged = (path, expected) => {
  try {
    if (readFileSync(path).equals(expected)) {
      rmSync(path, { force: true });

      return true;
    }
  } catch {
    /* already gone, or replaced: either way nothing to do */
  }

  return false;
};

/**
 * Takes the claim, or returns why it could not be taken. The returned
 * `release()` is idempotent and removes only this process's own claim.
 */
export const acquireClaim = ({
  projectRoot,
  pid = process.pid,
  purpose = 'operation',
  isAlive = processAlive,
  identityOf = ownerIdentity,
  attempts = 8,
}) => {
  const paths = campaignPaths(projectRoot);

  mkdirSync(paths.stateDirectory, { recursive: true });

  const owner = identityOf(pid);
  const record = `${JSON.stringify(
    { version: CLAIM_VERSION, pid, owner, purpose, takenAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
  const recordBytes = Buffer.from(record);

  /*
   * `path` names the claim file the refusal is actually about. The
   * generation-0 pathname is not always the one at fault, and an operator
   * told to remove `campaign.claim` when the unreadable file is
   * `campaign.claim.g3` is being pointed at the wrong file — possibly a
   * valid one (audit #5).
   */
  const refuse = (reason, holder, path = null) => ({
    ok: false,
    reason,
    holder: holder?.pid ?? null,
    purpose: holder?.purpose ?? null,
    path,
  });

  /*
   * The last rival that was found alive during confirmation. If the
   * attempts run out while somebody else is still holding the section,
   * "held" is the truthful answer; "contended" is reserved for losing the
   * creation race repeatedly without ever seeing a live owner.
   */
  let lastLiveRival = null;
  let lastLiveRivalPath = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = currentClaim(paths);
    let generation = 0;

    if (existing !== null) {
      const state = claimHolderState(existing.record, isAlive, identityOf);

      if (state === 'alive') {
        return refuse('held', existing.record, existing.path);
      }

      if (state === 'unreadable') {
        return refuse('unreadable', existing.record, existing.path);
      }

      // Provably dead: take over by creating the *next* generation. If
      // another contender gets there first our create fails and we start
      // again — we never remove what it wrote.
      generation = existing.generation + 1;
    }

    const target = claimGenerationPath(paths, generation);

    try {
      writeFileSync(target, record, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        continue;
      }

      throw error;
    }

    /*
     * Confirmation. Winning the `wx` create settles *this pathname*, and
     * nothing more. It does not establish that this process may enter the
     * protected section, because generation numbers are **not globally
     * monotonic**: `listClaimGenerations` derives them from the names
     * present, so once the directory empties the next acquirer starts
     * again at zero. A generation below ours may therefore belong to an
     * owner that is *newer* than the dead record we read, and "nothing
     * above me" is not the same statement as "nobody else is live".
     *
     * So every other generation is re-read here and judged on the bytes
     * now present rather than on its number (audit #5, F-1 and F-2).
     */
    const rivals = [];

    for (const other of listClaimGenerations(paths)) {
      if (other.path === target) {
        continue;
      }

      const seen = readClaimAt(other.path);

      rivals.push({
        ...other,
        seen,
        // A rival that has vanished between the listing and the read is
        // not a rival. Anything we cannot parse is `unreadable`, and
        // `claimHolderState` fails closed on a running pid it cannot
        // identify, so neither becomes evidence that a rival is dead.
        state: seen === null ? 'gone' : claimHolderState(seen.record, isAlive, identityOf),
      });
    }

    const liveRival = rivals.find((other) => other.state === 'alive');
    const unreadableRival = rivals.find((other) => other.state === 'unreadable');
    const higher = rivals.find((other) => other.generation > generation);

    if (liveRival !== undefined) {
      /*
       * Somebody else is genuinely in the section — whatever generation
       * they hold. Withdraw the claim just created (our own bytes, so a
       * concurrent owner's file can never be the one removed) and try
       * again; if they are still there when the attempts run out the
       * caller is told the state is held rather than merely contended.
       */
      removeIfUnchanged(target, recordBytes);
      lastLiveRival = liveRival.seen?.record ?? null;
      lastLiveRivalPath = liveRival.path;

      continue;
    }

    if (unreadableRival !== undefined) {
      // Fail closed: a claim we cannot read is not ours to supersede, and
      // it is not evidence that the section is free.
      removeIfUnchanged(target, recordBytes);

      return refuse('unreadable', unreadableRival.seen?.record ?? null, unreadableRival.path);
    }

    if (higher !== undefined) {
      removeIfUnchanged(target, recordBytes);

      continue;
    }

    /*
     * Every remaining rival is below us and was observed dead a moment
     * ago. "A moment ago" is the whole difficulty, so the removal is
     * conditional on the exact bytes that were judged: if the pathname has
     * since been taken by a live owner it holds different bytes — a
     * different pid, a different `takenAt` — and `removeIfUnchanged`
     * leaves it alone. A loser can therefore never delete a winner's
     * claim, which is what the unconditional `rmSync` here allowed.
     */
    for (const stale of rivals) {
      if (stale.generation >= generation || stale.state !== 'dead' || stale.seen === null) {
        continue;
      }

      removeIfUnchanged(stale.path, stale.seen.bytes);
    }

    let released = false;

    return {
      ok: true,
      generation,
      path: target,
      /** Whether this process still owns the state it claimed. */
      holdsClaim: () => {
        try {
          return readFileSync(target).equals(recordBytes);
        } catch {
          return false;
        }
      },
      release: () => {
        if (released) {
          return;
        }

        released = true;

        // Conditional on the bytes being ours at the moment of deletion,
        // so a handle that has outlived its ownership cannot revoke a
        // later owner's claim at the same path.
        removeIfUnchanged(target, recordBytes);
      },
    };
  }

  if (lastLiveRival !== null) {
    return refuse('held', lastLiveRival, lastLiveRivalPath);
  }

  return { ok: false, reason: 'contended', holder: null, purpose: null, path: null };
};

/**
 * Every claim file currently on disk, of any generation. Callers that need
 * to assert "no claim was left behind" must use this rather than testing
 * the generation-0 pathname alone.
 */
export const claimFootprint = (projectRoot) =>
  listClaimGenerations(campaignPaths(projectRoot)).map((entry) => entry.path);

/**
 * The claims held by test suites that the interlock has already admitted
 * (audit B-2), filtered to the ones whose process is still alive.
 *
 * A one-time check at suite startup cannot exclude a campaign that starts
 * *afterwards*: the audit measured an admitted suite reading mutated
 * content in 52,120 of 110,402 reads of a single source file while a
 * campaign ran underneath it. A suite therefore registers for its whole
 * lifetime, and a campaign consults the register before it mutates
 * anything.
 */
export const liveReaders = ({
  projectRoot,
  isAlive = processAlive,
  identityOf = ownerIdentity,
  excludePid = null,
}) => {
  const paths = campaignPaths(projectRoot);
  let names;

  try {
    names = readdirSync(paths.readerDirectory);
  } catch {
    return [];
  }

  const readers = [];

  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }

    const file = join(paths.readerDirectory, name);
    const record = readJsonFile(file);
    const pid = record?.pid;

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      // Unreadable registration: it tells us a suite was here and nothing
      // more, so treat it as live rather than ignore it. A dead suite's
      // entry is removed by the sweep below only when we can prove it dead.
      readers.push({ pid: null, file, evidence: 'an unreadable suite registration' });
      continue;
    }

    if (pid === excludePid) {
      continue;
    }

    if (!isAlive(pid)) {
      rmSync(file, { force: true });
      continue;
    }

    const current = identityOf(pid);

    if (typeof record.owner === 'string' && current !== null && current !== record.owner) {
      // The pid was recycled: that suite is gone.
      rmSync(file, { force: true });
      continue;
    }

    readers.push({
      pid,
      file,
      evidence: `a test suite admitted at ${String(record.startedAt ?? 'an unknown time')}`,
    });
  }

  return readers;
};

/** Registers this test process as a reader for the lifetime of its suite. */
export const registerReader = ({ projectRoot, pid = process.pid, identityOf = ownerIdentity }) => {
  const paths = campaignPaths(projectRoot);

  mkdirSync(paths.readerDirectory, { recursive: true });

  const file = join(paths.readerDirectory, `${String(pid)}.json`);

  writeFileSync(
    file,
    `${JSON.stringify(
      { pid, owner: identityOf(pid), startedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );

  return () => {
    rmSync(file, { force: true });
  };
};
