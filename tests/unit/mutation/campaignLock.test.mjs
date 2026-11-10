/**
 * The mutation campaign's lock, authorisation and recovery journal.
 *
 * These are the decisions that keep a campaign from being mistaken for a
 * regression and keep an interrupted campaign from leaving a mutant in the
 * tree (`docs/M7_INVESTIGATION.md` §14.8 G-c, G-d, G-e). Every one of them is
 * a pure function or takes its filesystem through an argument, so none of
 * these tests sleeps, spawns, or signals anything: the liveness of a process
 * is injected, and the only real files are in a temporary directory this file
 * owns.
 *
 * The one thing that cannot be tested here is SIGKILL itself — a mock of an
 * uncatchable signal proves nothing. That is
 * `scripts/mutation-sigkill-experiment.mjs`, which kills a real campaign in a
 * disposable copy of the repository.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORISATION_ENV,
  acquireClaim,
  assessRecovery,
  claimFootprint,
  campaignPaths,
  classifyLock,
  clearJournal,
  clearMarker,
  interlockDecision,
  isAuthorisedSubprocess,
  isOwnedPath,
  liveReaders,
  markerFileList,
  mintAuthorisation,
  ownerIdentity,
  readJsonFile,
  registerReader,
  resolveOwnership,
  readLockFile,
  recoverJournal,
  sha256,
  writeFileDurably,
  writeJournal,
  writeMarker,
} from '../../../scripts/mutation/campaignLock.mjs';

const alive = () => true;
const dead = () => false;

const OWNER = 'linux:boot-id:1000';

/** The owner identity probe for a pid that is still the process it was. */
const sameOwner = () => OWNER;
/** A pid that is alive, but alive as something else: a recycled pid. */
const recycled = () => 'linux:boot-id:9999';
/** A platform that cannot answer the question at all. */
const unknowable = () => null;

const lockRecord = (overrides = {}) => ({
  pid: 4242,
  owner: OWNER,
  startedAt: '2026-10-15T00:00:00.000Z',
  secretDigest: sha256('a-secret'),
  ...overrides,
});

describe('what a lock file means', () => {
  it('is absent when there is no record at all', () => {
    expect(classifyLock({ record: null, pid: 1, isAlive: alive })).toBe('absent');
  });

  it('is live when its owner is still running', () => {
    expect(
      classifyLock({ record: lockRecord(), pid: 1, isAlive: alive, identityOf: sameOwner }),
    ).toBe('live');
  });

  it('is stale when its owner is gone', () => {
    expect(
      classifyLock({ record: lockRecord(), pid: 1, isAlive: dead, identityOf: sameOwner }),
    ).toBe('stale');
  });

  it('is malformed when the record carries no usable pid, rather than being trusted', () => {
    expect(classifyLock({ record: { pid: 'nonsense' }, pid: 1, isAlive: alive })).toBe('malformed');
    expect(classifyLock({ record: { pid: -3 }, pid: 1, isAlive: alive })).toBe('malformed');
  });

  it('knows its own lock, so a campaign never refuses itself', () => {
    expect(classifyLock({ record: lockRecord({ pid: 99 }), pid: 99, isAlive: alive })).toBe('self');
  });
});

describe('telling the campaign own subprocesses from everyone else', () => {
  const { secret, secretDigest } = mintAuthorisation();
  const record = lockRecord({ pid: 777, secretDigest });

  it('admits a child that carries the secret and the owning pid', () => {
    expect(
      isAuthorisedSubprocess({
        record,
        identityOf: sameOwner,
        env: { [AUTHORISATION_ENV.pid]: '777', [AUTHORISATION_ENV.secret]: secret },
        isAlive: alive,
      }),
    ).toBe(true);
  });

  it('refuses a process that presents the digest from the lock file as if it were the secret', () => {
    // This is the whole reason the lock stores a digest and not the secret:
    // anything that can read the lock could otherwise authorise itself.
    expect(
      isAuthorisedSubprocess({
        record,
        identityOf: sameOwner,
        env: { [AUTHORISATION_ENV.pid]: '777', [AUTHORISATION_ENV.secret]: secretDigest },
        isAlive: alive,
      }),
    ).toBe(false);
  });

  it('refuses the right secret against the wrong owner', () => {
    expect(
      isAuthorisedSubprocess({
        record,
        identityOf: sameOwner,
        env: { [AUTHORISATION_ENV.pid]: '778', [AUTHORISATION_ENV.secret]: secret },
        isAlive: alive,
      }),
    ).toBe(false);
  });

  it('refuses a bare flag with no secret behind it', () => {
    expect(
      isAuthorisedSubprocess({
        record,
        identityOf: sameOwner,
        env: { [AUTHORISATION_ENV.pid]: '777', [AUTHORISATION_ENV.secret]: '' },
        isAlive: alive,
      }),
    ).toBe(false);

    expect(isAuthorisedSubprocess({ record, env: {}, isAlive: alive, identityOf: sameOwner })).toBe(
      false,
    );
  });

  it('refuses a secret belonging to a campaign that is no longer running', () => {
    expect(
      isAuthorisedSubprocess({
        record,
        identityOf: sameOwner,
        env: { [AUTHORISATION_ENV.pid]: '777', [AUTHORISATION_ENV.secret]: secret },
        isAlive: dead,
      }),
    ).toBe(false);
  });
});

describe('the interlock an ordinary test run passes through', () => {
  const { secret, secretDigest } = mintAuthorisation();
  const record = lockRecord({ pid: 555, secretDigest });
  const lockFile = '/somewhere/mutation-campaign.lock';

  it('lets the suite run when no campaign holds the tree', () => {
    const decision = interlockDecision({
      record: null,
      env: {},
      pid: 1,
      isAlive: alive,
      identityOf: sameOwner,
      lockFile,
    });

    expect(decision.allowed).toBe(true);
  });

  it('stops the suite when an unrelated campaign is live, and says why', () => {
    const decision = interlockDecision({
      record,
      env: {},
      pid: 1,
      isAlive: alive,
      identityOf: sameOwner,
      lockFile,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('live-campaign');
    expect(decision.message).toContain('a mutation campaign is running');
    expect(decision.message).toContain('555');
    expect(decision.message).toContain('--recover');
    expect(decision.message).toContain(lockFile);
  });

  it('lets the campaign own test subprocess through', () => {
    const decision = interlockDecision({
      record,
      env: { [AUTHORISATION_ENV.pid]: '555', [AUTHORISATION_ENV.secret]: secret },
      pid: 1,
      isAlive: alive,
      identityOf: sameOwner,
      lockFile,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('authorised-subprocess');
  });

  it('does not mistake a stale lock for a live campaign', () => {
    const decision = interlockDecision({
      record,
      env: {},
      pid: 1,
      isAlive: dead,
      identityOf: sameOwner,
      lockFile,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('stale');
  });

  it('does not let an unrelated process bypass a live campaign with a guessed secret', () => {
    const decision = interlockDecision({
      record,
      env: { [AUTHORISATION_ENV.pid]: '555', [AUTHORISATION_ENV.secret]: 'let-me-in' },
      pid: 1,
      isAlive: alive,
      identityOf: sameOwner,
      lockFile,
    });

    expect(decision.allowed).toBe(false);
  });
});

describe('paths a campaign is allowed to own', () => {
  it('accepts a repository-relative file', () => {
    expect(isOwnedPath('/repo', 'src/main/index.ts')).toBe(true);
  });

  it('refuses an escape, an absolute path and nothing at all', () => {
    expect(isOwnedPath('/repo', '../elsewhere/file.ts')).toBe(false);
    expect(isOwnedPath('/repo', '/etc/passwd')).toBe(false);
    expect(isOwnedPath('/repo', '')).toBe(false);
    expect(isOwnedPath('/repo', undefined)).toBe(false);
  });
});

describe('the recovery journal', () => {
  let root;
  const file = 'src/example.ts';
  const original = 'export const answer = 42;\n';
  const mutated = 'export const answer = 41;\n';

  const target = () => join(root, file);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutation-journal-test-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(target(), original);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Does what a campaign does: journal first, then mutate. */
  const plant = () => {
    writeJournal({
      projectRoot: root,
      mutantId: 'X1-example',
      pid: 1234,
      entries: [{ file, original, mutated }],
    });
    writeFileDurably(target(), mutated);
  };

  it('is written before the source file changes, and records both digests', () => {
    plant();

    const journal = readJsonFile(campaignPaths(root).journalFile);

    expect(journal.version).toBe(1);
    expect(journal.mutantId).toBe('X1-example');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0].originalDigest).toBe(sha256(original));
    expect(journal.entries[0].mutatedDigest).toBe(sha256(mutated));
    expect(readFileSync(join(root, journal.entries[0].blob), 'utf8')).toBe(original);
  });

  it('restores the original bytes exactly', () => {
    plant();

    const outcome = recoverJournal({
      projectRoot: root,
      journal: readJsonFile(campaignPaths(root).journalFile),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.restored).toEqual([file]);
    expect(readFileSync(target(), 'utf8')).toBe(original);
  });

  it('is safe to repeat: a second recovery finds the work already done', () => {
    plant();

    const journal = readJsonFile(campaignPaths(root).journalFile);

    recoverJournal({ projectRoot: root, journal });
    const second = recoverJournal({ projectRoot: root, journal });

    expect(second.ok).toBe(true);
    expect(second.restored).toEqual([]);
    expect(second.skipped).toEqual([file]);
    expect(readFileSync(target(), 'utf8')).toBe(original);
  });

  it('refuses a file that is neither the mutant nor the original, and changes nothing', () => {
    plant();

    const edited = 'export const answer = 42; // someone was working here\n';

    writeFileSync(target(), edited);

    const outcome = recoverJournal({
      projectRoot: root,
      journal: readJsonFile(campaignPaths(root).journalFile),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toEqual([file]);
    expect(outcome.details.join(' ')).toContain('changed by something else');
    expect(readFileSync(target(), 'utf8')).toBe(edited);
  });

  it('leaves an unrelated file alone, because it is not in the journal', () => {
    const bystander = join(root, 'src', 'bystander.ts');

    writeFileSync(bystander, 'const mine = true;\n');
    plant();

    recoverJournal({
      projectRoot: root,
      journal: readJsonFile(campaignPaths(root).journalFile),
    });

    expect(readFileSync(bystander, 'utf8')).toBe('const mine = true;\n');
  });

  it('refuses a journal entry that points outside the repository', () => {
    const outcome = recoverJournal({
      projectRoot: root,
      journal: {
        version: 1,
        entries: [{ file: '../escape.ts', blob: 'x', originalDigest: 'a', mutatedDigest: 'b' }],
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.details.join(' ')).toContain('not a path this campaign can own');
  });

  it('refuses a recorded original whose bytes do not match its own digest', () => {
    plant();

    const journal = readJsonFile(campaignPaths(root).journalFile);

    writeFileSync(join(root, journal.entries[0].blob), 'tampered\n');

    const outcome = recoverJournal({ projectRoot: root, journal });

    expect(outcome.ok).toBe(false);
    expect(readFileSync(target(), 'utf8')).toBe(mutated);
  });

  it('refuses a journal from a version it does not understand', () => {
    const outcome = recoverJournal({ projectRoot: root, journal: { version: 99, entries: [] } });

    expect(outcome.ok).toBe(false);
  });

  it('is cleared only by an explicit call, so an interrupted recovery still has its record', () => {
    plant();

    expect(readJsonFile(campaignPaths(root).journalFile)).not.toBeNull();

    clearJournal(root);

    expect(readJsonFile(campaignPaths(root).journalFile)).toBeNull();
  });
});

describe('durable writes', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutation-durable-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves no temporary file behind when it succeeds', () => {
    const path = join(root, 'file.ts');

    writeFileDurably(path, 'contents\n');

    expect(readFileSync(path, 'utf8')).toBe('contents\n');
    expect(() => readFileSync(`${path}.mutation-tmp`, 'utf8')).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * The independent audit of slice 1 (D-1 … D-5)
 * ------------------------------------------------------------------ */

describe('where the recovery state lives', () => {
  it('keeps nothing a recovery depends on inside node_modules', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'mutation-repository-'));
    const paths = campaignPaths(repositoryRoot);
    const stateRoot = resolve(repositoryRoot, '.mutation-state');
    const isWithinDirectory = (parent, candidate) => {
      const rel = relative(resolve(parent), resolve(candidate));
      return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    };

    try {
      for (const path of [
        paths.stateDirectory,
        paths.lockFile,
        paths.markerFile,
        paths.journalFile,
        paths.journalDirectory,
        paths.claimFile,
        paths.readerDirectory,
      ]) {
        expect(isWithinDirectory(stateRoot, path)).toBe(true);
        expect(path.toLowerCase()).not.toContain(`node_modules${sep}`.toLowerCase());
      }
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});

describe('a lock file that cannot be read is not a lock file that is absent', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutation-lock-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const lockFile = () => join(root, 'campaign.lock');

  it('reports a genuinely missing file as absent', () => {
    const read = readLockFile(lockFile());

    expect(read).toEqual({ exists: false, readable: true, record: null });
    expect(classifyLock({ ...read, pid: 1, isAlive: alive })).toBe('absent');
  });

  it('reports a file of unparseable rubbish as malformed, not absent', () => {
    writeFileSync(lockFile(), 'not json');

    const read = readLockFile(lockFile());

    expect(read.exists).toBe(true);
    expect(read.record).toBeNull();
    expect(classifyLock({ ...read, pid: 1, isAlive: alive })).toBe('malformed');
  });

  it('reports a truncated lock — valid JSON, no pid — as malformed', () => {
    writeFileSync(lockFile(), '{"startedAt":"2026-10-19T00:00:00.000Z"}');

    expect(classifyLock({ ...readLockFile(lockFile()), pid: 1, isAlive: alive })).toBe('malformed');
  });

  it('reports a lock with no secret digest as malformed, because nothing could be authorised against it', () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: 4242, owner: OWNER }));

    expect(classifyLock({ ...readLockFile(lockFile()), pid: 1, isAlive: alive })).toBe('malformed');
  });

  it('reports a file that exists but cannot be opened as malformed', () => {
    writeFileSync(lockFile(), JSON.stringify(lockRecord()));
    chmodSync(lockFile(), 0o000);

    const read = readLockFile(lockFile());

    // Running as root would make this unreadable file readable; skip rather
    // than assert something the environment has made untrue.
    if (read.readable) {
      return;
    }

    expect(read.exists).toBe(true);
    expect(classifyLock({ ...read, pid: 1, isAlive: alive })).toBe('malformed');
  });

  it('never produces the TypeError the audit found: no caller can dereference a null record', () => {
    writeFileSync(lockFile(), 'not json');

    const read = readLockFile(lockFile());
    const state = classifyLock({ ...read, pid: 1, isAlive: alive });

    // The crash was `held.pid` on a null `held` in the stale-takeover
    // message. The classification is what guards it: `malformed` has no pid
    // to report, and the runner's message for it mentions no pid.
    expect(state).toBe('malformed');
    expect(() =>
      interlockDecision({ ...read, env: {}, pid: 1, isAlive: alive, lockFile: lockFile() }),
    ).not.toThrow();
  });
});

describe('a pid that is alive is not necessarily the process that took the lock', () => {
  it('is live when the pid is alive and is the same process', () => {
    expect(
      classifyLock({ record: lockRecord(), pid: 1, isAlive: alive, identityOf: sameOwner }),
    ).toBe('live');
  });

  it('is stale when the pid is alive but belongs to a different process now', () => {
    expect(
      classifyLock({ record: lockRecord(), pid: 1, isAlive: alive, identityOf: recycled }),
    ).toBe('stale');
  });

  it('is indeterminate — never live, never stale — when the platform cannot say', () => {
    expect(
      classifyLock({ record: lockRecord(), pid: 1, isAlive: alive, identityOf: unknowable }),
    ).toBe('indeterminate');
  });

  it('is indeterminate for a lock that recorded no owner identity at all', () => {
    const record = lockRecord();

    delete record.owner;

    expect(classifyLock({ record, pid: 1, isAlive: alive, identityOf: sameOwner })).toBe(
      'indeterminate',
    );
  });

  it('stops an ordinary suite on an indeterminate lock, and tells it how to get out', () => {
    const decision = interlockDecision({
      record: lockRecord(),
      env: {},
      pid: 1,
      isAlive: alive,
      identityOf: unknowable,
      lockFile: '/repo/.mutation-state/campaign.lock',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('indeterminate-owner');
    expect(decision.message).toContain('--force');
  });

  it('refuses to authorise a child against a recycled pid, even with the right secret', () => {
    const { secret, secretDigest } = mintAuthorisation();
    const record = lockRecord({ pid: 555, secretDigest });
    const env = { [AUTHORISATION_ENV.pid]: '555', [AUTHORISATION_ENV.secret]: secret };

    expect(isAuthorisedSubprocess({ record, env, isAlive: alive, identityOf: sameOwner })).toBe(
      true,
    );
    expect(isAuthorisedSubprocess({ record, env, isAlive: alive, identityOf: recycled })).toBe(
      false,
    );
  });

  it('reads a real identity for this very process, and a different one for a pid that cannot exist', () => {
    // Guards the mechanism itself: a probe that always returned null would
    // make every lock indeterminate and every test above vacuous.
    expect(typeof ownerIdentity(process.pid)).toBe('string');
    expect(ownerIdentity(2 ** 31 - 1)).toBeNull();
  });
});

describe('telling "no interrupted campaign" from "the journal is gone"', () => {
  let root;
  const file = 'src/example.ts';
  const original = 'export const answer = 42;\n';
  const mutated = 'export const answer = 41;\n';
  const target = () => join(root, file);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutation-marker-test-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(target(), original);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const marker = (phase, files = []) =>
    writeMarker({ projectRoot: root, pid: 4242, owner: OWNER, phase, mutantId: 'X1', files });

  const digests = [{ file, originalDigest: sha256(original), mutatedDigest: sha256(mutated) }];

  it('says nothing happened when nothing happened', () => {
    expect(assessRecovery({ projectRoot: root }).action).toBe('none');
  });

  it('finalises a campaign that took the lock and never mutated anything', () => {
    marker('started');

    const assessment = assessRecovery({ projectRoot: root });

    expect(assessment.action).toBe('finalise');
    expect(assessment.reason).toBe('started-never-mutated');
  });

  it('recovers when a journal describes work to finish', () => {
    marker('mutating', digests);
    writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 4242,
      entries: [{ file, original, mutated }],
    });
    writeFileDurably(target(), mutated);

    expect(assessRecovery({ projectRoot: root }).action).toBe('recover');
  });

  it('REFUSES when the campaign was mutating, the journal is gone and the file is still the mutant', () => {
    // This is audit defect D-1 reproduced as a unit: SIGKILL, then `npm ci`
    // takes the journal with it. Before the remediation this state was
    // indistinguishable from "nothing to do" and was reported as success.
    marker('mutating', digests);
    writeFileDurably(target(), mutated);

    const assessment = assessRecovery({ projectRoot: root });

    expect(assessment.action).toBe('refuse');
    expect(assessment.reason).toBe('journal-missing');
    expect(assessment.verdicts).toEqual([{ file, state: 'mutated' }]);
    expect(assessment.message).toContain(file);
    expect(assessment.message).toContain('--clear-recovery-state');
  });

  it('refuses just as firmly when the file has been changed into something nobody recorded', () => {
    marker('mutating', digests);
    writeFileDurably(target(), 'export const answer = 7; // a human\n');

    const assessment = assessRecovery({ projectRoot: root });

    expect(assessment.action).toBe('refuse');
    expect(assessment.verdicts).toEqual([{ file, state: 'changed' }]);
  });

  it('finalises a lost journal only when every recorded file is provably its original', () => {
    marker('mutating', digests);

    const assessment = assessRecovery({ projectRoot: root });

    expect(assessment.action).toBe('finalise');
    expect(assessment.reason).toBe('journal-missing-tree-proven-clean');
  });

  it('finalises a campaign killed between its verified restore and its cleanup', () => {
    marker('restored', digests);

    expect(assessRecovery({ projectRoot: root }).action).toBe('finalise');
  });

  it('refuses a marker it cannot read rather than assuming the best', () => {
    marker('started');
    writeFileSync(campaignPaths(root).markerFile, 'not json');

    const assessment = assessRecovery({ projectRoot: root });

    expect(assessment.action).toBe('refuse');
    expect(assessment.reason).toBe('marker-unreadable');
  });

  it('refuses a journal it cannot parse rather than skipping it', () => {
    marker('mutating', digests);
    writeFileSync(campaignPaths(root).journalFile, '{ truncated');

    const assessment = assessRecovery({ projectRoot: root });

    expect(assessment.action).toBe('refuse');
    expect(assessment.reason).toBe('journal-unusable');
  });

  it('still recovers from a journal whose marker has been lost', () => {
    writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 4242,
      entries: [{ file, original, mutated }],
    });
    writeFileDurably(target(), mutated);
    clearMarker(root);

    expect(assessRecovery({ projectRoot: root }).action).toBe('recover');
  });

  it('stops an ordinary suite when recovery is outstanding, even with no lock at all', () => {
    marker('mutating', digests);
    writeFileDurably(target(), mutated);

    const decision = interlockDecision({
      record: null,
      exists: false,
      env: {},
      pid: 1,
      isAlive: dead,
      lockFile: campaignPaths(root).lockFile,
      recovery: assessRecovery({ projectRoot: root }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('recovery-inconsistent');
  });

  it('stops an ordinary suite while a journal is outstanding', () => {
    writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 4242,
      entries: [{ file, original, mutated }],
    });
    writeFileDurably(target(), mutated);

    const decision = interlockDecision({
      record: null,
      exists: false,
      env: {},
      pid: 1,
      isAlive: dead,
      lockFile: campaignPaths(root).lockFile,
      recovery: assessRecovery({ projectRoot: root }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('recovery-required');
    expect(decision.message).toContain('--recover');
  });

  it('still lets the campaign own children run while its own mutation is outstanding', () => {
    const { secret, secretDigest } = mintAuthorisation();

    writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 4242,
      entries: [{ file, original, mutated }],
    });

    const decision = interlockDecision({
      record: lockRecord({ pid: 555, secretDigest }),
      exists: true,
      env: { [AUTHORISATION_ENV.pid]: '555', [AUTHORISATION_ENV.secret]: secret },
      pid: 1,
      isAlive: alive,
      identityOf: sameOwner,
      lockFile: campaignPaths(root).lockFile,
      recovery: assessRecovery({ projectRoot: root }),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('authorised-subprocess');
  });
});

describe('restoration puts back the file, not an approximation of it', () => {
  let root;
  const file = 'scripts/example.sh';
  const original = '#!/bin/sh\necho original\n';
  const mutated = '#!/bin/sh\necho mutant\n';
  const target = () => join(root, file);
  const modeOf = (path) => statSync(path).mode & 0o7777;
  const expectedMode = () => modeOf(target());

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutation-mode-test-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(target(), original);
    chmodSync(target(), 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records the permission bits in the journal, before the file is touched', () => {
    writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 1,
      entries: [{ file, original, mutated }],
    });

    expect(readJsonFile(campaignPaths(root).journalFile).entries[0].mode).toBe(expectedMode());
  });

  it('restores the exact bytes and the exact mode an executable file had', () => {
    const journal = writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 1,
      entries: [{ file, original, mutated }],
    });

    writeFileDurably(target(), mutated, { mode: journal[0].mode });

    expect(readFileSync(target(), 'utf8')).toBe(mutated);
    expect(modeOf(target())).toBe(expectedMode());

    const outcome = recoverJournal({
      projectRoot: root,
      journal: readJsonFile(campaignPaths(root).journalFile),
    });

    expect(outcome.ok).toBe(true);
    expect(readFileSync(target(), 'utf8')).toBe(original);
    // The audit measured 0755 coming back 0644 here (D-3).
    expect(modeOf(target())).toBe(expectedMode());
  });

  it('puts the permissions back even when the bytes were already correct', () => {
    writeJournal({
      projectRoot: root,
      mutantId: 'X1',
      pid: 1,
      entries: [{ file, original, mutated }],
    });
    chmodSync(target(), 0o644);

    const outcome = recoverJournal({
      projectRoot: root,
      journal: readJsonFile(campaignPaths(root).journalFile),
    });

    expect(outcome.ok).toBe(true);
    expect(modeOf(target())).toBe(expectedMode());
  });
});

/**
 * Ownership, decided from the lock and the marker together.
 *
 * The second audit's blocking finding (R-1): a live campaign's lock was
 * corrupted, and the malformed lock fell past the `live` guard into the
 * clearing paths, so a second campaign deleted the first one's marker and
 * journal and restored its in-flight files underneath it. The real two-process
 * version of that race is `tests/integration/mutation/campaignRace.test.mjs`;
 * these cases pin the decision itself, with liveness and identity injected so
 * every combination is reachable deterministically.
 */
describe('resolveOwnership', () => {
  const SELF = 999_001;
  const OTHER = 999_002;

  const resolve = ({ lock, marker, alive = [], identities = {}, campaigns = {} }) =>
    resolveOwnership({
      lock,
      marker,
      pid: SELF,
      isAlive: (pid) => alive.includes(pid),
      identityOf: (pid) => identities[pid] ?? null,
      isCampaign: (pid) => campaigns[pid] ?? null,
    });

  const present = (record) => ({ exists: true, record });
  const unreadable = { exists: true, record: null };
  const absent = { exists: false, record: null };

  it('reports no owner when neither file exists', () => {
    expect(resolve({ lock: absent, marker: absent }).state).toBe('none');
  });

  it('refuses a live owner whose identity still matches', () => {
    const owner = resolve({
      lock: present({ pid: OTHER, owner: 'linux:boot:100' }),
      marker: absent,
      alive: [OTHER],
      identities: { [OTHER]: 'linux:boot:100' },
    });

    expect(owner.state).toBe('live');
    expect(owner.pid).toBe(OTHER);
  });

  it('treats a recycled pid as stale rather than live', () => {
    const owner = resolve({
      lock: present({ pid: OTHER, owner: 'linux:boot:100' }),
      marker: absent,
      alive: [OTHER],
      // Same pid, different start time: this is not the process that locked.
      identities: { [OTHER]: 'linux:boot:40000' },
    });

    expect(owner.state).toBe('stale');
  });

  it('is the regression for R-1: a malformed lock cannot hide a live marker', () => {
    const owner = resolve({
      lock: unreadable,
      marker: present({ pid: OTHER, owner: 'linux:boot:100' }),
      alive: [OTHER],
      identities: { [OTHER]: 'linux:boot:100' },
    });

    // The old build classified this as `malformed` and cleared the state.
    expect(owner.state).toBe('live');
    expect(owner.pid).toBe(OTHER);
    expect(owner.source).toBe('marker');
  });

  it('is indeterminate when the lock is unreadable and there is no marker', () => {
    expect(resolve({ lock: unreadable, marker: absent }).state).toBe('indeterminate');
  });

  it('is indeterminate when both files are unreadable', () => {
    expect(resolve({ lock: unreadable, marker: unreadable }).state).toBe('indeterminate');
  });

  it('is indeterminate when a record exists but names no usable pid', () => {
    for (const pid of [undefined, null, 'seven', -1, 0, 1.5]) {
      expect(resolve({ lock: present({ pid, owner: 'x' }), marker: absent }).state).toBe(
        'indeterminate',
      );
    }
  });

  it('lets an intact marker settle a damaged lock when the owner is provably gone', () => {
    // Without this, a corrupt lock would strand the tree forever: recovery
    // must still run once the original process is conclusively absent.
    const owner = resolve({
      lock: unreadable,
      marker: present({ pid: OTHER, owner: 'linux:boot:100' }),
      alive: [],
    });

    expect(owner.state).toBe('stale');
    expect(owner.pid).toBe(OTHER);
  });

  it('prefers the live claim when the two files disagree', () => {
    const owner = resolve({
      lock: present({ pid: 999_003, owner: 'linux:boot:1' }),
      marker: present({ pid: OTHER, owner: 'linux:boot:100' }),
      alive: [OTHER],
      identities: { [OTHER]: 'linux:boot:100' },
    });

    expect(owner.state).toBe('live');
    expect(owner.pid).toBe(OTHER);
  });

  it('recognises its own state', () => {
    expect(resolve({ lock: present({ pid: SELF, owner: 'x' }), marker: absent }).state).toBe(
      'self',
    );
  });

  it('uses the process command as a fallback when no identity was recorded', () => {
    const live = resolve({
      lock: present({ pid: OTHER }),
      marker: absent,
      alive: [OTHER],
      campaigns: { [OTHER]: true },
    });
    const recycled = resolve({
      lock: present({ pid: OTHER }),
      marker: absent,
      alive: [OTHER],
      campaigns: { [OTHER]: false },
    });
    const unknown = resolve({
      lock: present({ pid: OTHER }),
      marker: absent,
      alive: [OTHER],
      campaigns: { [OTHER]: null },
    });

    expect(live.state).toBe('live');
    expect(recycled.state).toBe('stale');
    // No /proc (or no answer): fail closed rather than guess.
    expect(unknown.state).toBe('indeterminate');
  });
});

/**
 * A marker's file list is evidence or it is nothing (R-2, R-3).
 */
describe('markerFileList', () => {
  const root = '/tmp/does-not-need-to-exist';
  const digest = 'a'.repeat(64);

  it('rejects a list that is not a list', () => {
    for (const files of [undefined, null, 'nonsense', 42, {}]) {
      expect(markerFileList(root, files).usable).toBe(false);
    }
  });

  it('rejects an empty list instead of treating it as "nothing to check"', () => {
    const outcome = markerFileList(root, []);

    expect(outcome.usable).toBe(false);
    expect(outcome.reason).toMatch(/recorded no files/u);
  });

  it('rejects an entry with no usable original digest', () => {
    for (const originalDigest of [undefined, null, '', 'short', `${digest}0`, 'Z'.repeat(64)]) {
      expect(markerFileList(root, [{ file: 'src/a.ts', originalDigest }]).usable).toBe(false);
    }
  });

  it('rejects a path that escapes the project root', () => {
    // The guard is containment, not a subtree allow-list: a marker that
    // names a file outside the repository is never acted on.
    for (const file of ['../escape.ts', '/etc/passwd', '../../tmp/x.ts', undefined, null, 7]) {
      expect(markerFileList(root, [{ file, originalDigest: digest }]).usable).toBe(false);
    }
  });

  it('accepts a well-formed list', () => {
    const outcome = markerFileList(root, [
      { file: 'src/a.ts', originalDigest: digest, mode: 0o644 },
    ]);

    expect(outcome.usable).toBe(true);
    expect(outcome.entries).toHaveLength(1);
  });
});

/**
 * What the runner is allowed to claim when there is no state to find (R-4).
 *
 * `.mutation-state/` is ignored by Git, so `git clean -fdX` deletes the
 * journal, the original bytes and every trace that a campaign was ever
 * interrupted. After that the runner has nothing to detect and nothing to
 * recover, and the re-audit found it reporting "nothing to recover" in a tree
 * that still held a planted fault. It may describe its own state files; it
 * may not imply it has checked the source.
 */
describe('the wording of a recovery that found no state', () => {
  const source = readFileSync(
    new URL('../../../scripts/mutation-test.mjs', import.meta.url),
    'utf8',
  );

  it('names the commands that destroy recovery evidence', () => {
    expect(source).toContain('git clean -fdX');
    expect(source).toContain('-fdx');
  });

  it('keeps the distinction between npm ci and deleting ignored files', () => {
    // Surviving `npm ci` is the point of living outside node_modules (D-1);
    // surviving explicit deletion of ignored files is impossible, and the
    // documentation must not blur the two.
    expect(source).toMatch(/npm ci/u);
    expect(source).toMatch(/ignored by Git/u);
  });

  it('says the absence of state files is not a clean working tree', () => {
    expect(source).toMatch(/not a check of the working tree/u);
    expect(source).toMatch(/never a statement that the working\n \* tree is clean/u);
  });

  it('points at version control as the recovery of last resort', () => {
    expect(source).toMatch(/git status --short -- src/u);
    expect(source).toMatch(/trusted baseline/u);
  });

  it('never claims it verified the source when it found no state', () => {
    const message = source.slice(
      source.indexOf('no mutation recovery state was found'),
      source.indexOf('recovery complete:'),
    );

    expect(message.length).toBeGreaterThan(0);
    // The phrasings that would overclaim.
    expect(message).not.toMatch(/nothing to recover/u);
    expect(message).not.toMatch(/tree is clean/u);
    expect(message).not.toMatch(/verified/u);
  });

  it('does not offer --force as a way past uncertain ownership', () => {
    expect(source).toContain('--force does not override uncertain ownership');
    expect(source).toContain('--force does not override a live campaign');
  });
});

/**
 * The exclusive claim (third audit, finding B-1).
 *
 * Knowing who owns the state is not the same as holding it. The audit
 * released real processes against one stale transaction through a
 * filesystem barrier and watched two of them both report "recovery
 * complete", two campaigns reach their control run at once, and an `ENOENT`
 * collision on one file's atomic rename. The claim is what makes the
 * critical section a critical section; the race itself is exercised with
 * real processes in `scripts/mutation-sigkill-experiment.mjs`.
 */
describe('acquireClaim', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claim-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const alive = (pids) => (pid) => pids.includes(pid);

  // Per-pid identities: a stub that answers the same for every pid makes a
  // live holder look like a recycled one.
  const identities = (map) => (pid) => map[pid] ?? null;

  it('lets exactly one of many contenders in', () => {
    const first = acquireClaim({
      projectRoot: root,
      pid: 1,
      identityOf: identities({ 1: 'a' }),
    });
    const second = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 1: 'a', 2: 'b' }),
      isAlive: alive([1, 2]),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('held');
    expect(second.holder).toBe(1);
  });

  it('lets the next one in once the first releases', () => {
    const first = acquireClaim({ projectRoot: root, pid: 1, identityOf: () => 'a' });
    first.release();

    expect(acquireClaim({ projectRoot: root, pid: 2, identityOf: () => 'b' }).ok).toBe(true);
  });

  it('release is idempotent and never removes a claim it does not own', () => {
    const first = acquireClaim({ projectRoot: root, pid: 1, identityOf: () => 'a' });
    first.release();

    const second = acquireClaim({ projectRoot: root, pid: 2, identityOf: () => 'b' });

    first.release(); // the stale handle must not delete pid 2's claim

    expect(second.ok).toBe(true);
    expect(existsSync(campaignPaths(root).claimFile)).toBe(true);
  });

  it('steals a claim whose holder is provably dead, so recovery stays possible', () => {
    acquireClaim({ projectRoot: root, pid: 1, identityOf: () => 'a' });

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: () => 'b',
      isAlive: alive([2]),
    });

    expect(taken.ok).toBe(true);
  });

  it('treats a recycled holder pid as dead', () => {
    acquireClaim({ projectRoot: root, pid: 1, identityOf: () => 'original' });

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: (pid) => (pid === 1 ? 'something-else-entirely' : 'b'),
      isAlive: alive([1, 2]),
    });

    expect(taken.ok).toBe(true);
  });

  it('refuses a claim it cannot read rather than deleting it', () => {
    mkdirSync(campaignPaths(root).stateDirectory, { recursive: true });
    writeFileSync(campaignPaths(root).claimFile, 'not json');

    const taken = acquireClaim({ projectRoot: root, pid: 2, identityOf: () => 'b' });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('unreadable');
    expect(existsSync(campaignPaths(root).claimFile)).toBe(true);
  });
});

/**
 * Suites registered for their lifetime (third audit, finding B-2).
 *
 * The interlock used to be a start-time check only, so a campaign that
 * began afterwards rewrote source underneath an executing suite — measured
 * at 52,120 of 110,402 reads of one file returning mutated or mid-rename
 * content.
 */
describe('liveReaders', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'readers-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports nothing when no suite has registered', () => {
    expect(liveReaders({ projectRoot: root })).toEqual([]);
  });

  it('reports a registered suite and forgets it when it deregisters', () => {
    const deregister = registerReader({ projectRoot: root, pid: 4242, identityOf: () => 'a' });

    expect(liveReaders({ projectRoot: root, isAlive: () => true }).map((r) => r.pid)).toEqual([
      4242,
    ]);

    deregister();

    expect(liveReaders({ projectRoot: root, isAlive: () => true })).toEqual([]);
  });

  it('sweeps a suite that was killed, so a crash cannot block campaigns for ever', () => {
    registerReader({ projectRoot: root, pid: 4242, identityOf: () => 'a' });

    expect(liveReaders({ projectRoot: root, isAlive: () => false })).toEqual([]);
  });

  it('sweeps a registration whose pid has been recycled', () => {
    registerReader({ projectRoot: root, pid: 4242, identityOf: () => 'original' });

    expect(
      liveReaders({ projectRoot: root, isAlive: () => true, identityOf: () => 'someone-else' }),
    ).toEqual([]);
  });

  it('counts an unreadable registration as live rather than ignoring it', () => {
    mkdirSync(campaignPaths(root).readerDirectory, { recursive: true });
    writeFileSync(join(campaignPaths(root).readerDirectory, 'x.json'), 'not json');

    expect(liveReaders({ projectRoot: root }).length).toBe(1);
  });

  it('does not report the asking process itself', () => {
    registerReader({ projectRoot: root, pid: 4242, identityOf: () => 'a' });

    expect(liveReaders({ projectRoot: root, isAlive: () => true, excludePid: 4242 })).toEqual([]);
  });
});

/**
 * The interlock must not treat an unreadable lock as an absent one — the
 * R-1 defect, which survived one layer up until the third audit.
 */
describe('interlockDecision and locks it cannot read', () => {
  const base = {
    env: {},
    pid: 500,
    lockFile: '/tmp/lock',
    recovery: { action: 'none' },
  };

  it('refuses when the lock file exists but cannot be parsed', () => {
    const decision = interlockDecision({ ...base, record: null, exists: true });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('malformed-lock');
  });

  it('refuses when a marker still names a live owner and the lock is unreadable', () => {
    const decision = interlockDecision({
      ...base,
      record: null,
      exists: true,
      marker: { exists: true, record: { pid: 600, owner: 'linux:boot:1' } },
      isAlive: (pid) => pid === 600,
      identityOf: () => 'linux:boot:1',
    });

    expect(decision.allowed).toBe(false);
  });

  it('still admits an ordinary suite when there is no lock at all', () => {
    expect(interlockDecision({ ...base, record: null, exists: false }).allowed).toBe(true);
  });
});

/**
 * Atomic ownership transfer (fourth audit, blocking finding B-1).
 *
 * The previous reclamation read the stale claim, compared its bytes and
 * then unlinked it *by pathname*. A contender that replaced the claim
 * between the comparison and the unlink had its live claim deleted by the
 * loser, so both processes believed they held the state — reproduced by
 * the audit in 9 of 40 two-process rounds. Ownership is now taken by
 * creating the next generation with `wx`, so losing is an `EEXIST` from a
 * process's own create rather than a failed comparison before someone
 * else's delete, and no acquisition path deletes a live claim.
 */
describe('atomic claim ownership transfer', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claim-transfer-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const alive = (pids) => (pid) => pids.includes(pid);
  const identities = (map) => (pid) => map[pid] ?? null;

  /** Writes a claim at a chosen generation without going through acquire. */
  const plantClaim = (generation, record) => {
    const paths = campaignPaths(root);

    mkdirSync(paths.stateDirectory, { recursive: true });

    const path = generation === 0 ? paths.claimFile : `${paths.claimFile}.g${String(generation)}`;

    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

    return path;
  };

  it('takes over a dead holder by creating the next generation, not by deleting', () => {
    const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };
    const planted = plantClaim(0, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(taken.ok).toBe(true);
    expect(taken.generation).toBe(1);
    expect(taken.holdsClaim()).toBe(true);
    // The superseded generation is swept only after the new one exists.
    expect(existsSync(planted)).toBe(false);
    expect(claimFootprint(root)).toEqual([taken.path]);
  });

  it('refuses rather than superseding a holder that is still running', () => {
    const first = acquireClaim({
      projectRoot: root,
      pid: 1,
      identityOf: identities({ 1: 'a' }),
      isAlive: alive([1]),
    });
    const bytesBefore = readFileSync(first.path);

    const second = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 1: 'a', 2: 'b' }),
      isAlive: alive([1, 2]),
    });

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('held');
    expect(second.holder).toBe(1);
    // The live holder's claim is untouched, and no second claim appeared.
    expect(readFileSync(first.path).equals(bytesBefore)).toBe(true);
    expect(claimFootprint(root)).toEqual([first.path]);
    expect(first.holdsClaim()).toBe(true);
  });

  it('never lets a loser revoke the winner at the generation it lost', () => {
    const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };

    plantClaim(0, dead);

    // The winner takes generation 1.
    const winner = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(winner.generation).toBe(1);

    // A loser that had already decided generation 1 was free now finds it
    // occupied by a living process and must back off without touching it.
    const loser = acquireClaim({
      projectRoot: root,
      pid: 3,
      identityOf: identities({ 2: 'b', 3: 'c' }),
      isAlive: alive([2, 3]),
    });

    expect(loser.ok).toBe(false);
    expect(loser.reason).toBe('held');
    expect(winner.holdsClaim()).toBe(true);
    expect(claimFootprint(root)).toEqual([winner.path]);
  });

  it('withdraws its own claim when it finds a higher generation already taken', () => {
    const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };
    const live = { version: 1, pid: 9, owner: 'niner', purpose: 'live', takenAt: 'now' };

    // A contender whose view of the directory is behind reality: generation
    // 0 looks dead, but generation 2 is already held by a running process.
    plantClaim(0, dead);
    plantClaim(2, live);

    const late = acquireClaim({
      projectRoot: root,
      pid: 3,
      identityOf: identities({ 9: 'niner', 3: 'c' }),
      isAlive: alive([9, 3]),
    });

    expect(late.ok).toBe(false);
    expect(late.reason).toBe('held');
    expect(late.holder).toBe(9);
    // It did not leave a claim of its own behind, and did not remove the
    // live owner's.
    expect(claimFootprint(root).some((path) => path.endsWith('.g2'))).toBe(true);
  });

  it('keeps recovery possible after the holder dies at the transfer boundary', () => {
    const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };

    plantClaim(0, dead);

    const crashed = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(crashed.generation).toBe(1);

    // pid 2 is killed without releasing: its claim outlives it and must not
    // block the state for ever.
    const next = acquireClaim({
      projectRoot: root,
      pid: 3,
      identityOf: identities({ 3: 'c' }),
      isAlive: alive([3]),
    });

    expect(next.ok).toBe(true);
    expect(next.generation).toBe(2);
    expect(claimFootprint(root)).toEqual([next.path]);
  });

  it('treats an orphan from a crashed withdrawal as superseded rubbish', () => {
    const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };

    // A contender crashed after creating generation 1 and before withdrawing.
    plantClaim(0, dead);
    plantClaim(1, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 4,
      identityOf: identities({ 4: 'd' }),
      isAlive: alive([4]),
    });

    expect(taken.ok).toBe(true);
    expect(taken.generation).toBe(2);
    expect(claimFootprint(root)).toEqual([taken.path]);
  });

  it('refuses a claim it cannot read instead of superseding it', () => {
    const paths = campaignPaths(root);

    mkdirSync(paths.stateDirectory, { recursive: true });
    writeFileSync(paths.claimFile, 'not json at all');

    const taken = acquireClaim({ projectRoot: root, pid: 2, identityOf: () => 'b' });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('unreadable');
    expect(existsSync(paths.claimFile)).toBe(true);
    expect(claimFootprint(root)).toEqual([paths.claimFile]);
  });

  it('releases only its own bytes, so a stale handle cannot revoke a later owner', () => {
    const first = acquireClaim({
      projectRoot: root,
      pid: 1,
      identityOf: identities({ 1: 'a' }),
      isAlive: alive([1]),
    });

    first.release();

    const second = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    // The stale handle releases again, long after it stopped owning
    // anything, at a pathname the new owner now occupies.
    first.release();

    expect(second.ok).toBe(true);
    expect(second.holdsClaim()).toBe(true);
    expect(claimFootprint(root)).toEqual([second.path]);
  });

  it('reports the whole claim footprint, not just generation zero', () => {
    const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };

    plantClaim(0, dead);
    plantClaim(3, dead);

    expect(claimFootprint(root)).toHaveLength(2);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    // Taking over sweeps every superseded generation, so "no claim left
    // behind" can be asserted on the footprint rather than one pathname.
    expect(taken.generation).toBe(4);
    expect(claimFootprint(root)).toEqual([taken.path]);

    taken.release();

    expect(claimFootprint(root)).toEqual([]);
  });
});

/**
 * Generation reuse (fifth audit, blocking findings F-1 and F-2).
 *
 * The generation scheme above fixed the deletion-based handover but left
 * two assumptions that do not hold. Generation numbers are derived from
 * the filenames present, so when the claim directory empties the next
 * acquirer starts again at zero: a *lower* generation can therefore belong
 * to a *newer* owner. On that basis the previous build
 *
 *   - swept every lower generation with an unconditional `rmSync` by
 *     pathname, which deleted the claim of a live owner that had taken a
 *     recycled number (F-1), and
 *   - confirmed an acquisition by looking only for *higher* generations,
 *     so two processes could hold two different generations and both
 *     believe they were in the protected section (F-2).
 *
 * The audit reproduced overlapping critical sections in four of five
 * unforced contention runs, and none of the tests above detected it —
 * they all pass against the broken sweep. These do not.
 */
describe('claim ownership across generation reuse', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claim-reuse-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const alive = (pids) => (pid) => pids.includes(pid);
  const identities = (map) => (pid) => map[pid] ?? null;

  const plantClaim = (generation, record) => {
    const paths = campaignPaths(root);

    mkdirSync(paths.stateDirectory, { recursive: true });

    const path = generation === 0 ? paths.claimFile : `${paths.claimFile}.g${String(generation)}`;

    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

    return path;
  };

  const dead = { version: 1, pid: 1, owner: 'gone', purpose: 'dead', takenAt: 'then' };

  it('does not delete a live owner that holds a lower generation than its own', () => {
    // Generation 0 belongs to a *running* process; generation 1 is a
    // leftover from a dead one. This is the shape the directory has after
    // it emptied and was re-entered at zero.
    const live = { version: 1, pid: 7, owner: 'seven', purpose: 'live', takenAt: 'now' };
    const livePath = plantClaim(0, live);
    const liveBytes = readFileSync(livePath);

    plantClaim(1, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b', 7: 'seven' }),
      isAlive: alive([2, 7]),
    });

    // The contender must not enter, and must not have touched the live
    // claim on its way out.
    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('held');
    expect(existsSync(livePath)).toBe(true);
    expect(readFileSync(livePath).equals(liveBytes)).toBe(true);
  });

  it('withdraws rather than entering beside a live rival at any generation', () => {
    const live = { version: 1, pid: 7, owner: 'seven', purpose: 'live', takenAt: 'now' };

    plantClaim(0, live);
    plantClaim(5, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b', 7: 'seven' }),
      isAlive: alive([2, 7]),
    });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('held');
    expect(taken.holder).toBe(7);

    // Its own attempt was withdrawn: nothing of the contender's survives.
    const footprint = claimFootprint(root);

    expect(footprint).toHaveLength(2);
    expect(footprint.some((path) => path.endsWith('.g6'))).toBe(false);
  });

  it('names the generation that is unreadable, not generation zero', () => {
    plantClaim(0, dead);

    const paths = campaignPaths(root);
    const corrupt = `${paths.claimFile}.g2`;

    writeFileSync(corrupt, 'not json at all');

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('unreadable');
    // The operator is pointed at `campaign.claim.g2`, not `campaign.claim`.
    expect(taken.path).toBe(corrupt);
    expect(existsSync(corrupt)).toBe(true);
  });

  it('treats an unreadable lower generation as a reason to stop, not as a dead one', () => {
    const paths = campaignPaths(root);

    mkdirSync(paths.stateDirectory, { recursive: true });
    writeFileSync(paths.claimFile, '{ this is not json');
    plantClaim(1, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('unreadable');
    // Fail closed: an unparsable claim is never swept.
    expect(existsSync(paths.claimFile)).toBe(true);
  });

  it('fails closed when a lower generation names a running pid it cannot identify', () => {
    // `identityOf` returning null is "this platform cannot say". That must
    // not be read as evidence the holder is gone.
    const unknown = { version: 1, pid: 8, owner: 'eight', purpose: 'live', takenAt: 'now' };
    const path = plantClaim(0, unknown);
    const bytes = readFileSync(path);

    plantClaim(2, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: (pid) => (pid === 2 ? 'b' : null),
      isAlive: alive([2, 8]),
    });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('held');
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('sweeps a lower generation only while its bytes are the ones it judged', () => {
    const stalePath = plantClaim(0, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(taken.ok).toBe(true);
    expect(taken.generation).toBe(1);
    // A genuinely dead lower generation is still cleaned up.
    expect(existsSync(stalePath)).toBe(false);
    expect(claimFootprint(root)).toEqual([taken.path]);
  });

  it('leaves a recycled generation alone when its bytes changed after the read', () => {
    /*
     * The F-1 interleaving, expressed through the public API. The
     * `readdirSync` the contender uses still reports a dead generation 0,
     * but by the time the sweep runs the pathname holds a *live* owner's
     * record. The sweep must notice the bytes are not the ones it judged.
     */
    const paths = campaignPaths(root);

    mkdirSync(paths.stateDirectory, { recursive: true });

    const live = { version: 1, pid: 7, owner: 'seven', purpose: 'live', takenAt: 'now' };

    plantClaim(0, dead);

    let swapped = false;

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b', 7: 'seven' }),
      isAlive: (pid) => {
        // The moment the contender finishes judging the dead record, the
        // pathname is taken over by a live process.
        if (!swapped && pid === 1) {
          swapped = true;
          writeFileSync(paths.claimFile, `${JSON.stringify(live, null, 2)}\n`);
        }

        return [2, 7].includes(pid);
      },
    });

    // Whatever it decides, the live owner's claim must survive intact.
    expect(existsSync(paths.claimFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.claimFile, 'utf8')).pid).toBe(7);

    if (taken.ok) {
      // If it entered at all it must not have entered beside the live one.
      expect(taken.generation).toBe(0);
    } else {
      expect(taken.reason).toBe('held');
    }
  });

  it('reports held, not contended, when the attempts run out against a live owner', () => {
    const live = { version: 1, pid: 7, owner: 'seven', purpose: 'live', takenAt: 'now' };

    plantClaim(0, live);
    plantClaim(3, dead);

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      attempts: 2,
      identityOf: identities({ 2: 'b', 7: 'seven' }),
      isAlive: alive([2, 7]),
    });

    expect(taken.ok).toBe(false);
    expect(taken.reason).toBe('held');
    expect(taken.holder).toBe(7);
  });

  it('still reclaims a wholly dead directory, so the fix did not cost liveness', () => {
    plantClaim(0, dead);
    plantClaim(2, { ...dead, pid: 3, owner: 'alsogone' });

    const taken = acquireClaim({
      projectRoot: root,
      pid: 2,
      identityOf: identities({ 2: 'b' }),
      isAlive: alive([2]),
    });

    expect(taken.ok).toBe(true);
    expect(taken.generation).toBe(3);
    expect(taken.holdsClaim()).toBe(true);
    expect(claimFootprint(root)).toEqual([taken.path]);

    taken.release();

    expect(claimFootprint(root)).toEqual([]);
  });
});
