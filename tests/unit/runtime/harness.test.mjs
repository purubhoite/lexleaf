/**
 * Tests for the runtime harness itself.
 *
 * A harness is a measuring instrument, and an instrument nobody checks is
 * an instrument that quietly reports what you hoped for. Three properties
 * are worth more than the rest and are what this file holds the harness
 * to:
 *
 * - **the settling rule is enforced, not described.** A caller cannot ask
 *   to read persisted state sooner than the floor the milestone fixed;
 * - **nothing is green by suppression.** An absent value, an unreadable
 *   state document and an unmet expectation are failures, and the line
 *   between "the X server is shutting down" and "the application went
 *   wrong" is drawn narrowly enough that a CSP violation can never land
 *   on the noise side of it;
 * - **two identical runs produce identical evidence.** Determinism is the
 *   difference between evidence a reviewer diffs and evidence a reviewer
 *   skims.
 *
 * These are the decidable parts, so they are tested here, in the ordinary
 * unit suite, with no Electron process and no X server. The parts that
 * cannot be tested without a display — launching, CDP, input dispatch —
 * are exercised by `npm run test:runtime`, which is a separate gate.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTLE_TIMEOUT_MS,
  EVIDENCE_SCHEMA,
  MAIN_WRITE_DELAY_MS,
  MINIMUM_SETTLE_MS,
  RENDERER_COALESCE_MS,
  buildEvidence,
  classifyStderrLine,
  expectStateValue,
  expectValue,
  isGreen,
  readPath,
  selectProductErrors,
  settlePlan,
  stableStringify,
  summariseChecks,
} from '../../../scripts/runtime/evidence.mjs';

describe('the persistence settling rule', () => {
  it('is at least the two coalescing delays the application actually has', () => {
    expect(RENDERER_COALESCE_MS).toBe(600);
    expect(MAIN_WRITE_DELAY_MS).toBe(1_000);
    expect(MINIMUM_SETTLE_MS).toBeGreaterThanOrEqual(RENDERER_COALESCE_MS + MAIN_WRITE_DELAY_MS);
    expect(MINIMUM_SETTLE_MS).toBe(2_000);
  });

  it('keeps a conservative bound above the floor, and says why in the plan', () => {
    const plan = settlePlan();

    expect(plan.minimumMs).toBe(MINIMUM_SETTLE_MS);
    expect(plan.timeoutMs).toBe(DEFAULT_SETTLE_TIMEOUT_MS);
    expect(plan.timeoutMs).toBeGreaterThan(plan.minimumMs);
    expect(plan.rationale).toContain('600');
    expect(plan.rationale).toContain('1000');
  });

  it('refuses to read the state sooner than the floor', () => {
    expect(() => settlePlan({ minimumMs: 0 })).toThrow(/at least 2000ms/u);
    expect(() => settlePlan({ minimumMs: 1_999 })).toThrow(/at least 2000ms/u);
    expect(() => settlePlan({ minimumMs: 1_600 })).toThrow(/at least 2000ms/u);
  });

  it('refuses a bound below its own floor, and a poll interval that never polls', () => {
    expect(() => settlePlan({ minimumMs: 3_000, timeoutMs: 2_500 })).toThrow(/must not be below/u);
    expect(() => settlePlan({ pollMs: 0 })).toThrow(/positive/u);
  });

  it('allows a longer wait, because waiting longer is never the unsafe direction', () => {
    expect(settlePlan({ minimumMs: 4_000, timeoutMs: 9_000 })).toMatchObject({
      minimumMs: 4_000,
      timeoutMs: 9_000,
    });
  });
});

describe('telling an application error from the environment', () => {
  const noise = [
    'XIO:  fatal IO error 11 (Resource temporarily unavailable) on X server ":99"',
    'The X11 connection broke: I/O error (code 1)',
    '[12:34:56] ERROR:gpu_memory_buffer_support_x11.cc(44)] dri3 extension not supported.',
    'ERROR:viz_main_impl.cc(186)] Exiting GPU process due to errors during initialization',
    '[3076:1002/064332.040723:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address',
    '[3076:1002/064332.136843:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner',
    '[10761:1007/134706.928477:ERROR:gpu/vulkan/vulkan_instance.cc(572)] Failed to create Vulkan instance',
    'MESA-LOADER: failed to open swrast',
    'libva error: vaGetDriverNames() failed with unknown libva error',
    'Fontconfig error: No writable cache directories',
    '(node:1234) ExperimentalWarning: SQLite is an experimental feature',
  ];

  const failures = [
    'Refused to execute inline script because it violates the following Content Security Policy directive: "script-src \'self\'"',
    'Uncaught TypeError: Cannot read properties of null',
    '[1:1:0101/000000.000000:ERROR:CONSOLE(1)] "Something broke", source: index.html',
    'renderer failed to load',
    'render-process-gone: reason=crashed',
    'UnhandledPromiseRejection: the reader state could not be saved',
    'Uncaught Error: Vulkan dictionary initialisation failed in the reader',
    'ERROR:CONSOLE(7)] "dbus lookup failed in the reader", source: app://reader',
  ];

  it('never calls teardown noise a product failure', () => {
    for (const line of noise) {
      expect(classifyStderrLine(line), line).toBe('environment');
    }

    expect(selectProductErrors(noise.join('\n'))).toStrictEqual([]);
  });

  it('never lets a real failure pass as noise', () => {
    for (const line of failures) {
      expect(classifyStderrLine(line), line).toBe('product-error');
    }

    expect(selectProductErrors(`${noise.join('\n')}\n${failures.join('\n')}`)).toHaveLength(
      failures.length,
    );
  });

  it('treats ordinary chatter as neither, so the harness does not fail on logging', () => {
    expect(classifyStderrLine('[reader] main window ready')).toBe('informational');
    expect(classifyStderrLine('[reader] Vulkan support is optional')).toBe('informational');
    expect(classifyStderrLine('[reader] dbus lookup is unavailable')).toBe('informational');
    expect(classifyStderrLine('')).toBe('blank');
    expect(selectProductErrors('[reader] main window ready\n\n')).toStrictEqual([]);
  });

  it('matches the smoke test, so the two gates cannot disagree about a failure', () => {
    // scripts/smoke-test.mjs FAILURE_PATTERNS, verbatim.
    for (const line of [
      'Refused to connect',
      'violates the following Content Security Policy',
      'Uncaught ReferenceError',
      'renderer failed to load',
      'ERROR:CONSOLE(7)',
      'the main process failed to start',
    ]) {
      expect(classifyStderrLine(line), line).toBe('product-error');
    }
  });
});

describe('expectations', () => {
  it('reads a nested path and says when it is absent', () => {
    const state = { preferences: { appearance: 'dark' }, documents: [{ name: 'a.pdf' }] };

    expect(readPath(state, 'preferences.appearance')).toStrictEqual({
      found: true,
      value: 'dark',
    });
    expect(readPath(state, 'documents.0.name')).toStrictEqual({ found: true, value: 'a.pdf' });
    expect(readPath(state, 'documents.1.name')).toStrictEqual({ found: false, value: undefined });
    expect(readPath(state, 'preferences.reduceMotion')).toStrictEqual({
      found: false,
      value: undefined,
    });
    expect(readPath(null, 'preferences')).toStrictEqual({ found: false, value: undefined });
  });

  it('fails an expectation whose value is missing rather than reporting nothing', () => {
    const check = expectStateValue({
      name: 'persisted appearance',
      state: { preferences: {} },
      path: 'preferences.appearance',
      expected: 'dark',
    });

    expect(check.pass).toBe(false);
    expect(check.found).toBe(false);
    expect(check.detail).toContain('absent');
  });

  it('fails when the state could not be read at all', () => {
    const check = expectStateValue({
      name: 'persisted appearance',
      state: null,
      path: 'preferences.appearance',
      expected: 'dark',
    });

    expect(check.pass).toBe(false);
  });

  it('compares by value, so an equal object passes and a different one does not', () => {
    expect(
      expectValue({ name: 'zoom', actual: { mode: 'fixed' }, expected: { mode: 'fixed' } }).pass,
    ).toBe(true);
    expect(
      expectValue({ name: 'zoom', actual: { mode: 'fixed' }, expected: { mode: 'fit-page' } }).pass,
    ).toBe(false);
    expect(expectValue({ name: 'open', actual: false, expected: true }).pass).toBe(false);
    expect(expectValue({ name: 'open', actual: null, expected: null }).pass).toBe(true);
  });

  it('summarises by naming what failed', () => {
    const checks = [
      expectValue({ name: 'a', actual: 1, expected: 1 }),
      expectValue({ name: 'b', actual: 1, expected: 2 }),
    ];

    expect(summariseChecks(checks)).toStrictEqual({
      total: 2,
      passed: 1,
      failed: 1,
      failures: ['b'],
    });
  });
});

describe('the evidence a run leaves behind', () => {
  const scenario = (name, checks, extra = {}) => ({ name, status: 'passed', checks, ...extra });

  const passing = [
    scenario('settings open and close', [
      expectValue({ name: 'shown', actual: true, expected: true }),
    ]),
    scenario('appearance', [expectValue({ name: 'theme', actual: 'dark', expected: 'dark' })]),
  ];

  it('is byte-identical for two runs that observed the same things', () => {
    const first = buildEvidence({ scenarios: passing, meta: { durationMs: 1_234 } });
    const second = buildEvidence({ scenarios: passing, meta: { durationMs: 9_876 } });

    expect(stableStringify(first.comparable)).toBe(stableStringify(second.comparable));
    expect(first.schema).toBe(EVIDENCE_SCHEMA);
  });

  it('keeps the timings that genuinely differ out of the comparable part', () => {
    const evidence = buildEvidence({ scenarios: passing, meta: { durationMs: 1_234 } });

    expect(stableStringify(evidence.comparable)).not.toContain('1234');
    expect(evidence.meta.durationMs).toBe(1_234);
  });

  it('orders object keys, so the file can be diffed', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}',
    );
  });

  it('records the settling rule it used, so the evidence proves the wait', () => {
    const { settling } = buildEvidence({ scenarios: passing }).comparable;

    expect(settling.minimumMs).toBe(MINIMUM_SETTLE_MS);
    expect(settling.rendererCoalesceMs).toBe(RENDERER_COALESCE_MS);
    expect(settling.mainWriteDelayMs).toBe(MAIN_WRITE_DELAY_MS);
    expect(settling.rationale).toContain('floor');
  });

  it('is green only when every scenario, every check and the log agree', () => {
    expect(isGreen(buildEvidence({ scenarios: passing }))).toBe(true);

    expect(
      isGreen(
        buildEvidence({
          scenarios: [scenario('a', [expectValue({ name: 'x', actual: 1, expected: 2 })])],
        }),
      ),
    ).toBe(false);

    expect(
      isGreen(
        buildEvidence({
          scenarios: [{ name: 'a', status: 'failed', checks: [], failure: 'cdp-timeout' }],
        }),
      ),
    ).toBe(false);

    expect(
      isGreen(
        buildEvidence({
          scenarios: [{ name: 'a', status: 'passed', checks: [], productErrors: ['Uncaught X'] }],
        }),
      ),
    ).toBe(false);
  });

  it('is not green for a run that asserted nothing but logged an error', () => {
    expect(isGreen(buildEvidence({ scenarios: [] }))).toBe(true);
    expect(
      isGreen(
        buildEvidence({
          scenarios: [{ name: 'a', status: 'passed', productErrors: ['Uncaught'] }],
        }),
      ),
    ).toBe(false);
  });
});

describe('the harness module', () => {
  it('offers the documented entry points without needing a display to import', async () => {
    const harness = await import('../../../scripts/runtime/harness.mjs');

    expect(typeof harness.startRuntimeSession).toBe('function');
    expect(typeof harness.withRuntimeSession).toBe('function');
    expect(typeof harness.HarnessFailure).toBe('function');
    expect(harness.PROJECT_ROOT).toMatch(/[\\/]$|[^\s]/u);

    const failure = new harness.HarnessFailure('renderer-unusable', 'the renderer never settled');

    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe('renderer-unusable');
  });
});
