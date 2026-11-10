/**
 * The decidable parts of the runtime harness.
 *
 * Everything in this module is a pure function of its arguments: the
 * settling rule, the rule that separates an application error from the
 * noise a windowless X server makes while it is being torn down, the
 * expectation records, and the serialisation that makes two runs of the
 * same scenario produce byte-identical evidence.
 *
 * It is separate from `harness.mjs` for one reason: these are the rules a
 * reviewer has to trust, and rules that can be unit-tested without an
 * Electron process are rules that stay true. `tests/unit/runtime/` tests
 * this file directly.
 */

/* ------------------------------------------------------------------ *
 * The persistence settling rule (M7.4 item 4)
 * ------------------------------------------------------------------ */

/**
 * How long the renderer holds a reading position before sending it.
 * `src/renderer/src/reader/useReadingPosition.ts`, `SETTLE_MS = 600`.
 */
export const RENDERER_COALESCE_MS = 600;

/**
 * How long the main process holds a change before writing it.
 * `src/main/persistence/readerStateStore.ts`, `DEFAULT_WRITE_DELAY_MS = 1000`.
 */
export const MAIN_WRITE_DELAY_MS = 1_000;

/**
 * The floor the milestone fixes: no runtime test may read
 * `reader-state.json` sooner than this after the last interaction that
 * could have changed it.
 *
 * It is not a guess. A reading position travels through two coalescing
 * stages before it reaches the disk — 600 ms in the renderer, then
 * 1000 ms in the main process — and the write itself is a `writeFile`
 * plus a `rename`. 1600 ms is therefore the earliest the bytes can
 * possibly be there, and reading at 1600 ms would be reading at exactly
 * the deadline. 2000 ms is that sum with the margin named, rather than a
 * number someone liked.
 */
export const MINIMUM_SETTLE_MS = 2_000;

/**
 * How long the harness keeps looking after the floor has passed.
 *
 * Nothing in the application announces "the state file is now current" —
 * the store coalesces internally and reports nothing — so the only
 * completion signal available from outside the process is the file. The
 * harness therefore polls for the *expected* content rather than sleeping
 * blind: it returns as soon as the value it was told to wait for appears,
 * which makes a passing run take about as long as the write actually
 * takes, and gives up at this bound. 4000 ms is the conservative default
 * the M6 audits used; it is kept because it is roughly 2.5× the 1600 ms
 * worst case, which absorbs a loaded CI machine without hiding a store
 * that never wrote at all.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 4_000;

/** How often the state file is re-read once the floor has passed. */
export const DEFAULT_SETTLE_POLL_MS = 100;

export const SETTLE_RATIONALE = [
  `renderer coalescing ${String(RENDERER_COALESCE_MS)}ms`,
  `main-process write delay ${String(MAIN_WRITE_DELAY_MS)}ms`,
  `floor ${String(MINIMUM_SETTLE_MS)}ms`,
  `poll until the expected value appears, bounded at ${String(DEFAULT_SETTLE_TIMEOUT_MS)}ms`,
].join('; ');

/**
 * Validates and normalises a settling request.
 *
 * Refusing a floor below {@link MINIMUM_SETTLE_MS} is the whole point:
 * the rule lives in code that throws, not in a comment a later test can
 * ignore.
 */
export const settlePlan = ({
  minimumMs = MINIMUM_SETTLE_MS,
  timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
  pollMs = DEFAULT_SETTLE_POLL_MS,
} = {}) => {
  if (!Number.isFinite(minimumMs) || minimumMs < MINIMUM_SETTLE_MS) {
    throw new Error(
      `persistence settling floor must be at least ${String(MINIMUM_SETTLE_MS)}ms ` +
        `(${String(RENDERER_COALESCE_MS)}ms renderer + ${String(MAIN_WRITE_DELAY_MS)}ms main ` +
        `+ margin); asked for ${String(minimumMs)}ms`,
    );
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs < minimumMs) {
    throw new Error(
      `persistence settling timeout (${String(timeoutMs)}ms) must not be below the ` +
        `floor (${String(minimumMs)}ms)`,
    );
  }

  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`persistence settling poll interval must be positive; got ${String(pollMs)}ms`);
  }

  return { minimumMs, timeoutMs, pollMs, rationale: SETTLE_RATIONALE };
};

/* ------------------------------------------------------------------ *
 * Telling an application error from the environment's own noise
 * ------------------------------------------------------------------ */

/**
 * Lines a headless X session produces that say nothing about the product.
 *
 * Every entry here is anchored to the component that emits it — a
 * Chromium source file, a dbus failure, or the X server going away while
 * the process that was drawing on it exits. A pattern broad enough to
 * swallow a renderer error would turn this harness into the thing it is
 * supposed to replace.
 */
const ENVIRONMENT_NOISE = [
  /XIO:\s+fatal IO error/u,
  /The X11 connection broke/u,
  /X connection to :\d+ broken/u,
  /Xlib:\s+extension "[^"]+" missing/u,
  /gpu_memory_buffer_support_x11\.cc/u,
  /viz_main_impl\.cc/u,
  /gbm_wrapper\.cc/u,
  /gl_display\.cc/u,
  /angle_platform_impl\.cc/u,
  /sandbox_linux\.cc/u,
  /bus\.cc/u,
  /object_proxy\.cc/u,
  /^\[\d+:\d+\/\d+\.\d+:\w+:(?:dbus\/)?(?:bus|object_proxy)\.cc(?:\(|:)\d+\]/u,
  /Failed to connect to the bus/u,
  /MESA-LOADER/u,
  /libva error/u,
  /Fontconfig (error|warning)/u,
  /dri3 extension not supported/u,
  /^\[\d+:\d+\/\d+\.\d+:\w+:[^\]]*\bvulkan[^\]]*\.(?:cc|h)(?:\(|:)\d+\)?\]/iu,
  /Failed to create GBM device/u,
  /XDG_RUNTIME_DIR/u,
  /ExperimentalWarning/u,
  /Exiting GPU process/u,
];

/**
 * Lines that mean the application itself went wrong.
 *
 * The first six are the smoke test's patterns, kept identical so the two
 * gates cannot disagree about what a failure is; the rest are the runtime
 * failures the harness can observe that a launch-only smoke test cannot.
 */
const PRODUCT_FAILURE = [
  /Refused to /iu,
  /violates the following Content Security Policy/iu,
  /Uncaught /u,
  /renderer failed to load/u,
  /ERROR:CONSOLE/u,
  /failed to start/u,
  /render-process-gone/u,
  /renderer process (crashed|gone)/iu,
  /UnhandledPromiseRejection/u,
];

/**
 * Classifies one line of the application's stderr.
 *
 * Product failures are decided first. Environment patterns are then narrow
 * and anchored to Chromium's structured stderr prefix where needed: this is
 * the only place where the harness is allowed to discard something, and a
 * mistake here is a silently green run.
 */
export const classifyStderrLine = (line) => {
  const text = String(line);

  if (text.trim() === '') {
    return 'blank';
  }

  if (PRODUCT_FAILURE.some((pattern) => pattern.test(text))) {
    return 'product-error';
  }

  if (ENVIRONMENT_NOISE.some((pattern) => pattern.test(text))) {
    return 'environment';
  }

  return 'informational';
};

/** Every line of a captured stream that indicates an application failure. */
export const selectProductErrors = (output) =>
  String(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => classifyStderrLine(line) === 'product-error');

/* ------------------------------------------------------------------ *
 * Expectations
 * ------------------------------------------------------------------ */

/** Reads `a.b.c` out of parsed JSON, distinguishing "absent" from "undefined". */
export const readPath = (value, path) => {
  const steps = String(path)
    .split('.')
    .filter((step) => step !== '');

  let cursor = value;

  for (const step of steps) {
    if (typeof cursor !== 'object' || cursor === null || !(step in cursor)) {
      return { found: false, value: undefined };
    }

    cursor = cursor[step];
  }

  return { found: true, value: cursor };
};

/**
 * One assertion, as it appears in the evidence.
 *
 * A missing value fails. There is no branch in which an absent key, an
 * unreadable file or an unchecked expectation is reported as a pass:
 * "could not tell" is a failure, because a harness that cannot tell is a
 * harness that proves nothing.
 */
export const expectValue = ({ name, actual, expected, found = true, detail = null }) => {
  const matches = found && stableStringify(actual) === stableStringify(expected);

  return {
    name: String(name),
    expected,
    actual: found ? actual : null,
    found,
    pass: matches,
    ...(detail === null ? {} : { detail: String(detail) }),
  };
};

/** The same check against a value read out of a parsed state document. */
export const expectStateValue = ({ name, state, path, expected }) => {
  const { found, value } = readPath(state, path);

  return expectValue({
    name,
    actual: value,
    expected,
    found,
    detail: found ? null : `${path} is absent from the persisted state`,
  });
};

export const summariseChecks = (checks) => {
  const failures = checks.filter((check) => !check.pass);

  return {
    total: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    failures: failures.map((check) => check.name),
  };
};

/* ------------------------------------------------------------------ *
 * Deterministic evidence
 * ------------------------------------------------------------------ */

/**
 * JSON with object keys in a fixed order.
 *
 * Two runs of the same scenario must produce the same bytes, or the
 * evidence cannot be diffed and nobody will read it. Key order is the
 * only non-determinism `JSON.stringify` introduces on its own; the
 * timings that genuinely differ are kept out of the comparable section
 * by {@link buildEvidence} rather than rounded into looking equal.
 */
export const stableStringify = (value, indent = 0) => {
  const normalise = (input) => {
    if (Array.isArray(input)) {
      return input.map(normalise);
    }

    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, normalise(input[key])]),
      );
    }

    return input;
  };

  return JSON.stringify(normalise(value), null, indent);
};

export const EVIDENCE_SCHEMA = 'intelligent-pdf-reader/runtime-evidence/1';

/**
 * Splits a run into the part two runs must agree on and the part they
 * cannot: `comparable` is deterministic and is what a reviewer diffs;
 * `meta` holds wall-clock times, durations, pids and paths.
 */
export const buildEvidence = ({ scenarios, meta = {} }) => {
  const checks = scenarios.flatMap((scenario) => scenario.checks ?? []);
  const errors = scenarios.flatMap((scenario) => scenario.productErrors ?? []);

  return {
    schema: EVIDENCE_SCHEMA,
    comparable: {
      scenarios: scenarios.map((scenario) => ({
        name: scenario.name,
        status: scenario.status,
        checks: (scenario.checks ?? []).map((check) => ({
          name: check.name,
          expected: check.expected,
          actual: check.actual,
          found: check.found,
          pass: check.pass,
        })),
        productErrors: scenario.productErrors ?? [],
        ...(scenario.failure === undefined ? {} : { failure: scenario.failure }),
      })),
      summary: {
        ...summariseChecks(checks),
        scenarios: scenarios.length,
        scenariosFailed: scenarios.filter((scenario) => scenario.status !== 'passed').length,
        productErrors: errors.length,
      },
      settling: {
        rendererCoalesceMs: RENDERER_COALESCE_MS,
        mainWriteDelayMs: MAIN_WRITE_DELAY_MS,
        minimumMs: MINIMUM_SETTLE_MS,
        timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
        rationale: SETTLE_RATIONALE,
      },
    },
    meta,
  };
};

/** True only when every scenario passed and nothing logged an error. */
export const isGreen = (evidence) =>
  evidence.comparable.summary.failed === 0 &&
  evidence.comparable.summary.scenariosFailed === 0 &&
  evidence.comparable.summary.productErrors === 0;
