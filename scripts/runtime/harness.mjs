/**
 * A durable runtime harness for the built application.
 *
 * This is the M6/M7 audit procedure — launch the real Electron build on a
 * private X display, drive it over the Chrome DevTools Protocol, look at
 * what the renderer actually computed, and read what reached the disk —
 * turned into repository-resident tooling instead of a script that lived
 * in `/tmp` and had to be rewritten from memory every audit.
 *
 * What it is built on, and what it deliberately is not:
 *
 * - Electron's own Chromium and its DevTools endpoint, reached with the
 *   `WebSocket` and `fetch` that Node 22 already provides. There is no
 *   Playwright, Puppeteer, Selenium, Cypress or WebdriverIO here, and no
 *   new dependency of any kind (ADR-first rule: a browser-automation
 *   framework would bring a second browser, a second driver protocol and
 *   a second idea of what "ready" means);
 * - real input. A click is `Input.dispatchMouseEvent` at the element's
 *   measured centre and a key is `Input.dispatchKeyEvent`, not
 *   `element.click()`, so the event path the reader uses is the event
 *   path the test uses;
 * - an isolated `--user-data-dir` per session, so a run never reads or
 *   writes the developer's own reading state, and two runs cannot see
 *   each other;
 * - failure by default. Every wait has a bound and every bound that is
 *   reached throws {@link HarnessFailure}. Nothing here returns "could
 *   not tell" as a pass.
 *
 * The rules that can be decided without a running application — the
 * persistence settling floor, what counts as an application error rather
 * than X-server teardown noise, and the deterministic shape of the
 * evidence — live in `./evidence.mjs` and are unit-tested.
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import electronBinary from 'electron';

import {
  classifyStderrLine,
  expectStateValue,
  expectValue,
  selectProductErrors,
  settlePlan,
  stableStringify,
} from './evidence.mjs';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MAIN_BUNDLE = join(PROJECT_ROOT, 'out', 'main', 'index.js');
const READER_STATE_FILE = 'reader-state.json';

const LAUNCH_TIMEOUT_MS = 45_000;
const RENDERER_READY_TIMEOUT_MS = 30_000;
const SELECTOR_TIMEOUT_MS = 10_000;
const CDP_CALL_TIMEOUT_MS = 20_000;
const TEARDOWN_GRACE_MS = 5_000;

/** Every way a run can fail, as a code the evidence can carry. */
export class HarnessFailure extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'HarnessFailure';
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * The display
 * ------------------------------------------------------------------ */

const xSocket = (number) => `/tmp/.X11-unix/X${String(number)}`;

/**
 * Uses the caller's X display, or starts a private Xvfb and owns it.
 *
 * "Owns it" is the part that matters at teardown: a harness that leaves
 * an X server behind makes the next run inherit state it cannot see.
 */
const startDisplay = async ({ geometry = '1400x1000x24' } = {}) => {
  const existing = process.env['DISPLAY'];

  if (typeof existing === 'string' && existing !== '') {
    return { display: existing, owned: false, stop: async () => {} };
  }

  let number = 99;
  while (number < 160 && existsSync(xSocket(number))) {
    number += 1;
  }

  if (number >= 160) {
    throw new HarnessFailure(
      'display-unavailable',
      'no free X display number between :99 and :159',
    );
  }

  const display = `:${String(number)}`;
  const child = spawn('Xvfb', [display, '-screen', '0', geometry, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError !== null) {
      throw new HarnessFailure(
        'display-unavailable',
        `could not start Xvfb on ${display}: ${spawnError.message}`,
      );
    }

    if (existsSync(xSocket(number))) {
      return {
        display,
        owned: true,
        stop: async () => {
          child.kill('SIGTERM');
          await delay(200);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        },
      };
    }

    await delay(100);
  }

  child.kill('SIGKILL');
  throw new HarnessFailure('display-unavailable', `Xvfb did not come up on ${display} within 10s`);
};

/* ------------------------------------------------------------------ *
 * The DevTools connection
 * ------------------------------------------------------------------ */

const freePort = async () =>
  await new Promise((resolveport, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        resolveport(port);
      });
    });
  });

/** Waits for the DevTools HTTP endpoint to offer a page target. */
const discoverPageTarget = async (port, deadline) => {
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${String(port)}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
      );

      if (page !== undefined) {
        return page;
      }

      lastError = `${String(targets.length)} target(s), none of type "page"`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(200);
  }

  throw new HarnessFailure(
    'devtools-unreachable',
    `no renderer target on the DevTools endpoint within the launch timeout (${lastError})`,
  );
};

/** A minimal CDP client: request/response by id, plus event listeners. */
const connectCdp = async (webSocketDebuggerUrl) => {
  const socket = new globalThis.WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let closed = null;
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));

    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id);
      pending.delete(message.id);

      if (waiter === undefined) {
        return;
      }

      if (message.error !== undefined) {
        waiter.reject(
          new HarnessFailure('cdp-error', `${waiter.method}: ${String(message.error.message)}`),
        );
        return;
      }

      waiter.resolve(message.result);
      return;
    }

    for (const handler of listeners.get(message.method) ?? []) {
      handler(message.params ?? {});
    }
  });

  socket.addEventListener('close', () => {
    closed = closed ?? 'the DevTools connection closed';
    for (const [, waiter] of pending) {
      waiter.reject(new HarnessFailure('cdp-closed', `${waiter.method}: ${closed}`));
    }
    pending.clear();
  });

  socket.addEventListener('error', () => {
    closed = 'the DevTools connection failed';
  });

  await new Promise((resolveopen, reject) => {
    if (socket.readyState === 1) {
      resolveopen();
      return;
    }

    const timer = setTimeout(() => {
      reject(new HarnessFailure('devtools-unreachable', 'the DevTools socket did not open'));
    }, 15_000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolveopen();
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new HarnessFailure('devtools-unreachable', 'the DevTools socket failed to open'));
    });
  });

  return {
    send: async (method, params = {}) => {
      if (closed !== null) {
        throw new HarnessFailure('cdp-closed', `${method}: ${closed}`);
      }

      const id = nextId;
      nextId += 1;

      const result = new Promise((resolveCall, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new HarnessFailure(
              'cdp-timeout',
              `${method} did not answer within ${String(CDP_CALL_TIMEOUT_MS)}ms`,
            ),
          );
        }, CDP_CALL_TIMEOUT_MS);

        pending.set(id, {
          method,
          resolve: (value) => {
            clearTimeout(timer);
            resolveCall(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });

      socket.send(JSON.stringify({ id, method, params }));

      return await result;
    },
    on: (method, handler) => {
      listeners.set(method, [...(listeners.get(method) ?? []), handler]);
    },
    close: () => {
      closed = closed ?? 'the harness closed the connection';
      try {
        socket.close();
      } catch {
        // Closing an already-dead socket is not a failure.
      }
    },
  };
};

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

const describeError = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Launches the built application and returns a driveable session.
 *
 * Fails — rather than returning something unusable — when the build is
 * missing, Electron will not start, the DevTools endpoint never appears
 * or the renderer never reaches a state a reader could use.
 */
export const startRuntimeSession = async ({
  evidenceDir,
  openDocument = null,
  userDataDir = null,
  geometry = '1400x1000x24',
  extraArgs = [],
  env = {},
} = {}) => {
  if (!existsSync(MAIN_BUNDLE)) {
    throw new HarnessFailure(
      'build-missing',
      `the built main process is not at ${MAIN_BUNDLE}; run "npm run build" first`,
    );
  }

  const shotsDir = join(evidenceDir, 'shots');
  await mkdir(shotsDir, { recursive: true });

  const ownedUserData = userDataDir === null;
  const dataDir = ownedUserData ? await mkdtemp(join(tmpdir(), 'ipr-runtime-')) : userDataDir;
  await mkdir(dataDir, { recursive: true });

  const display = await startDisplay({ geometry });
  const port = await freePort();

  const args = [
    PROJECT_ROOT,
    '--enable-logging=stderr',
    `--user-data-dir=${dataDir}`,
    `--remote-debugging-port=${String(port)}`,
    '--remote-allow-origins=*',
    '--disable-gpu',
    ...extraArgs,
  ];

  if (
    process.env['RUNTIME_DISABLE_CHROMIUM_SANDBOX'] === '1' ||
    process.env['SMOKE_DISABLE_CHROMIUM_SANDBOX'] === '1' ||
    process.getuid?.() === 0
  ) {
    args.push('--no-sandbox');
  }

  if (openDocument !== null) {
    args.push(`--open-document=${openDocument}`);
  }

  const child = spawn(electronBinary, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
      DISPLAY: display.display,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let exited = null;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const runtimeErrors = [];
  /** Patterns for error lines a scenario induced deliberately (M7.1). */
  const forgiven = [];
  const screenshots = [];
  let shotIndex = 0;
  let lastMutationAt = Date.now();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  let spawnFailure = null;
  child.on('error', (error) => {
    spawnFailure = error;
  });

  const stop = async () => {
    if (exited === null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + TEARDOWN_GRACE_MS;
      while (exited === null && Date.now() < deadline) {
        await delay(100);
      }
      if (exited === null) {
        child.kill('SIGKILL');
        await delay(300);
      }
    }

    await display.stop();

    if (ownedUserData && process.env['RUNTIME_KEEP_USER_DATA'] !== '1') {
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  const fail = async (code, message, detail = null) => {
    const failure = new HarnessFailure(code, message, detail);
    await stop();
    throw failure;
  };

  /* ---- connect ---- */

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let target;

  try {
    while (Date.now() < deadline) {
      if (spawnFailure !== null) {
        return await fail(
          'electron-not-started',
          `could not launch Electron: ${spawnFailure.message}`,
        );
      }

      if (exited !== null) {
        return await fail(
          'electron-exited',
          `Electron exited during start-up with code ${String(exited.code)}`,
          output.trim(),
        );
      }

      try {
        target = await discoverPageTarget(port, Math.min(deadline, Date.now() + 1_000));
        break;
      } catch (error) {
        if (!(error instanceof HarnessFailure)) {
          throw error;
        }
      }
    }

    if (target === undefined) {
      return await fail(
        'devtools-unreachable',
        `no renderer target within ${String(LAUNCH_TIMEOUT_MS)}ms`,
        output.trim(),
      );
    }
  } catch (error) {
    if (error instanceof HarnessFailure) {
      throw error;
    }
    return await fail('electron-not-started', describeError(error));
  }

  /*
   * The connection is a binding rather than a constant because M7.1 needs
   * to survive the renderer it is talking to. `Page.crash` kills the target
   * this socket belongs to, and the replacement renderer the application
   * creates is a new target with a new socket; everything below keeps
   * working because `attachCdp` re-registers the same listeners on it.
   */
  const CRASH_MARKER = 'render-process-gone: the renderer target crashed';

  const attachCdp = async (connection) => {
    connection.on('Runtime.exceptionThrown', (params) => {
      const text =
        params.exceptionDetails?.exception?.description ??
        params.exceptionDetails?.text ??
        'uncaught exception';
      runtimeErrors.push(`Uncaught ${String(text).split('\n')[0]}`);
    });

    connection.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') {
        return;
      }

      const text = (params.args ?? [])
        .map((argument) => String(argument.value ?? argument.description ?? ''))
        .join(' ')
        .trim();

      runtimeErrors.push(`ERROR:CONSOLE ${text}`);
    });

    connection.on('Inspector.targetCrashed', () => {
      runtimeErrors.push(CRASH_MARKER);
    });

    await connection.send('Runtime.enable');
    await connection.send('Page.enable');
    await connection.send('Inspector.enable');

    return connection;
  };

  let cdp = await attachCdp(await connectCdp(target.webSocketDebuggerUrl));

  /* ---- primitives ---- */

  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise,
    });

    if (result.exceptionDetails !== undefined) {
      throw new HarnessFailure(
        'evaluation-failed',
        `expression threw in the renderer: ${
          String(
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
          ).split('\n')[0]
        }`,
      );
    }

    return result.result.value;
  };

  const waitFor = async (expression, { timeoutMs = SELECTOR_TIMEOUT_MS, description } = {}) => {
    const until = Date.now() + timeoutMs;
    let last;

    while (Date.now() < until) {
      last = await evaluate(expression);

      if (last !== null && last !== undefined && last !== false) {
        return last;
      }

      await delay(100);
    }

    throw new HarnessFailure(
      'condition-never-true',
      `${description ?? expression} did not become true within ${String(timeoutMs)}ms`,
      stableStringify(last ?? null),
    );
  };

  const literal = (selector) => JSON.stringify(selector);

  /**
   * Waits for an element that could actually be clicked.
   *
   * A pointer event is dispatched at a window coordinate, so an element
   * that exists but sits below the fold is not clickable: the event would
   * land on whatever is at that point instead, and the test would fail
   * for a reason that has nothing to do with the product. The element is
   * therefore brought into view first — and only if it is not already
   * there, so the document's own scroll position is left alone — and an
   * element still outside the viewport afterwards keeps the wait going
   * rather than returning a coordinate that cannot be hit.
   */
  const requireSelector = async (selector, { timeoutMs = SELECTOR_TIMEOUT_MS } = {}) =>
    await waitFor(
      `const element = document.querySelector(${literal(selector)});
       if (element === null) { return null; }
       let rect = element.getBoundingClientRect();
       const outside = () =>
         rect.bottom <= 0 || rect.top >= window.innerHeight ||
         rect.right <= 0 || rect.left >= window.innerWidth;
       if (outside()) {
         element.scrollIntoView({ block: 'center', inline: 'nearest' });
         rect = element.getBoundingClientRect();
       }
       if (rect.width === 0 && rect.height === 0) { return null; }
       if (outside()) { return null; }
       return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
                width: rect.width, height: rect.height,
                text: (element.textContent ?? '').trim().slice(0, 200) };`,
      { timeoutMs, description: `selector ${selector}` },
    );

  const markMutation = () => {
    lastMutationAt = Date.now();
  };

  const click = async (selector, options = {}) => {
    const box = await requireSelector(selector, options);
    const point = { x: Math.round(box.x), y: Math.round(box.y) };

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });

    markMutation();
    return box;
  };

  const press = async (key, { code = key, text = undefined, modifiers = 0 } = {}) => {
    const base = { key, code, modifiers, windowsVirtualKeyCode: 0 };

    await cdp.send('Input.dispatchKeyEvent', {
      ...base,
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      ...(text === undefined ? {} : { text }),
    });
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });

    markMutation();
  };

  const computedStyle = async (selector, properties) =>
    await evaluate(
      `const element = document.querySelector(${literal(selector)});
       if (element === null) { return null; }
       const style = getComputedStyle(element);
       return Object.fromEntries(${JSON.stringify(properties)}.map((name) => [name, style.getPropertyValue(name).trim()]));`,
    );

  const screenshot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    shotIndex += 1;
    const file = join(shotsDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    screenshots.push(file);
    return file;
  };

  /* ---- persisted state, read only once it has settled ---- */

  const statePath = join(dataDir, READER_STATE_FILE);

  const readState = async () => {
    try {
      return { found: true, state: JSON.parse(await readFile(statePath, 'utf8')) };
    } catch (error) {
      return { found: false, state: null, reason: describeError(error) };
    }
  };

  /**
   * Reads `reader-state.json` only after the settling rule allows it.
   *
   * `expectations` is `{ 'a.b.c': value }`. The call waits out the floor,
   * then polls until every expectation holds, and fails if the bound is
   * reached — an expectation that never appears is a failure, never a
   * silently absent check.
   */
  const readSettledState = async ({ expectations = {}, settle = {}, label = 'state' } = {}) => {
    const plan = settlePlan(settle);
    const waitedFor = lastMutationAt + plan.minimumMs - Date.now();

    if (waitedFor > 0) {
      await delay(waitedFor);
    }

    const until = lastMutationAt + plan.timeoutMs;
    let snapshot = await readState();
    let checks;

    for (;;) {
      checks = Object.entries(expectations).map(([path, expected]) =>
        expectStateValue({
          name: `${label}: ${path}`,
          state: snapshot.state,
          path,
          expected,
        }),
      );

      if (snapshot.found && checks.every((check) => check.pass)) {
        break;
      }

      if (Date.now() >= until) {
        break;
      }

      await delay(plan.pollMs);
      snapshot = await readState();
    }

    if (!snapshot.found) {
      checks = [
        expectValue({
          name: `${label}: reader-state.json`,
          actual: null,
          expected: 'a readable state document',
          found: false,
          detail: snapshot.reason ?? 'not readable',
        }),
        ...checks,
      ];
    }

    return {
      path: statePath,
      found: snapshot.found,
      state: snapshot.state,
      checks,
      settling: { ...plan, waitedFromLastMutationMs: Date.now() - lastMutationAt },
    };
  };

  /* ---- crash and recovery (M7.1) ---- */

  /**
   * Crashes the renderer the way Chromium crashes one.
   *
   * `Page.crash` never answers — the process it would answer from is
   * gone — so the call is expected to end in a timeout or a closed
   * socket, and both are success here. Anything else is not.
   */
  const crashRenderer = async ({ attempts = 5 } = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await cdp.send('Page.crash');
        break;
      } catch (error) {
        if (!(error instanceof HarnessFailure)) {
          throw error;
        }

        // The process died before it could answer. That is the point.
        if (['cdp-timeout', 'cdp-closed'].includes(error.code)) {
          break;
        }

        if (error.code === 'cdp-error' && /Target crashed/u.test(error.message)) {
          break;
        }

        /*
         * Chromium refuses to kill a page that is mid-navigation. It is
         * a transient condition, so it is waited out rather than
         * reported as a crash that did not happen.
         */
        if (error.code === 'cdp-error' && /pending navigations/u.test(error.message)) {
          if (attempt >= attempts) {
            throw error;
          }

          await delay(500);
          continue;
        }

        throw error;
      }
    }

    forgiven.push(/Renderer process crashed/u, /render-process-gone: the renderer target crashed/u);
    markMutation();
  };

  /**
   * Re-attaches to whatever renderer target now exists.
   *
   * After a crash the application may reload the same `webContents` or
   * the target may be replaced; either way the old socket is dead. This
   * polls the DevTools endpoint until a page target answers an
   * evaluation, so it returns only when there is a renderer that can be
   * driven — not merely one that is listed.
   */
  const reconnect = async ({ timeoutMs = RENDERER_READY_TIMEOUT_MS } = {}) => {
    const deadline = Date.now() + timeoutMs;

    cdp.close();

    let lastError = 'no attempt';

    while (Date.now() < deadline) {
      try {
        const page = await discoverPageTarget(port, Math.min(deadline, Date.now() + 5_000));
        const connection = await attachCdp(await connectCdp(page.webSocketDebuggerUrl));
        const probe = await connection.send('Runtime.evaluate', {
          expression: '(() => document.readyState)()',
          returnByValue: true,
        });

        if (probe.result?.value === 'complete' || probe.result?.value === 'interactive') {
          cdp = connection;
          return true;
        }

        connection.close();
        lastError = `document.readyState was ${String(probe.result?.value)}`;
      } catch (error) {
        lastError = describeError(error);
      }

      await delay(250);
    }

    throw new HarnessFailure(
      'renderer-unusable',
      `no renderer could be driven again within ${String(timeoutMs)}ms (${lastError})`,
    );
  };

  /**
   * Accounts for a crash this harness caused on purpose.
   *
   * It removes **one** induced-crash record per call and nothing else:
   * a genuine renderer exception, a console error or a second crash the
   * test did not ask for all remain, and `assertHealthy` still fails on
   * them. Suppressing by category would defeat the point of the gate.
   */
  /**
   * Accounts for one error line this harness caused on purpose.
   *
   * The pattern must be given by the caller and consumes exactly one
   * matching line. Nothing is suppressed by category: a second,
   * unexpected occurrence of the same thing still fails the gate, and
   * every other error is untouched.
   */
  const forgiveOnce = (pattern) => {
    forgiven.push(pattern);
  };

  /* ---- health ---- */

  /**
   * Every line that indicates the application went wrong, minus the ones
   * a scenario induced on purpose.
   *
   * Each entry in `forgiven` cancels **one** line. A deliberate crash
   * therefore stops failing the gate while a second, unasked-for crash
   * still does, and a renderer exception that nobody induced is
   * untouched.
   */
  const productErrors = () => {
    const remaining = [...forgiven];

    return [...selectProductErrors(output), ...runtimeErrors].filter((line) => {
      const at = remaining.findIndex((pattern) => pattern.test(line));

      if (at === -1) {
        return true;
      }

      remaining.splice(at, 1);
      return false;
    });
  };

  const assertHealthy = () => {
    const errors = productErrors();

    if (errors.length > 0) {
      throw new HarnessFailure(
        'application-error',
        `the application reported ${String(errors.length)} error(s)`,
        errors.join('\n'),
      );
    }
  };

  /* ---- readiness ---- */

  try {
    await waitFor('return document.readyState === "complete" ? true : null;', {
      timeoutMs: RENDERER_READY_TIMEOUT_MS,
      description: 'the renderer document',
    });

    await waitFor(
      `return document.querySelector('[data-testid="library"], [data-testid="reader-surface"]') === null
         ? null : true;`,
      { timeoutMs: RENDERER_READY_TIMEOUT_MS, description: 'a usable reader surface' },
    );
  } catch (error) {
    cdp.close();
    await stop();

    if (error instanceof HarnessFailure) {
      throw new HarnessFailure('renderer-unusable', error.message, output.trim());
    }

    throw error;
  }

  return {
    display: display.display,
    userDataDir: dataDir,
    statePath,
    devtoolsPort: port,
    evaluate,
    waitFor,
    requireSelector,
    click,
    press,
    computedStyle,
    screenshot,
    readSettledState,
    markMutation,
    crashRenderer,
    reconnect,
    forgiveOnce,
    productErrors,
    assertHealthy,
    output: () => output,
    stderrClassification: () =>
      output
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => ({ line: line.trimEnd(), kind: classifyStderrLine(line) })),
    screenshots: () => [...screenshots],
    close: async () => {
      cdp.close();
      await stop();
    },
  };
};

/** Runs `body` against a session and tears the session down whatever happens. */
export const withRuntimeSession = async (options, body) => {
  const session = await startRuntimeSession(options);

  try {
    return await body(session);
  } finally {
    await session.close();
  }
};
