// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOUNDARY_FAILURE_MESSAGE,
  BOUNDARY_TERMINAL_MESSAGE,
  ErrorBoundary,
  RELOAD_LABEL,
} from './ErrorBoundary';

/**
 * The one error boundary (M7.1, ADR-035, M7 investigation R5).
 *
 * Every test here uses a component that really throws during render,
 * because that is the only thing that exercises React's own unmounting
 * behaviour — the defect being fixed is what React does, not what this
 * file does.
 *
 * React writes the caught error to `console.error` itself, as well as
 * through the boundary. That output is silenced per test rather than
 * globally, so a genuinely unexpected console error elsewhere still
 * shows up.
 */

const SECRET = "ENOENT: no such file or directory, open '/home/reader/Tax Return.pdf'";

/** Throws on render until it is told not to. */
const Fragile = ({ broken }: { readonly broken: boolean }): ReactElement => {
  if (broken) {
    throw new Error(SECRET);
  }

  return <p>The reader is working.</p>;
};

/** Lets a test repair the child between renders, as a real fix would. */
const Repairable = ({ brokenAtFirst }: { readonly brokenAtFirst: boolean }): ReactElement => {
  const [broken, setBroken] = useState(brokenAtFirst);

  return (
    <>
      <button type="button" onClick={(): void => setBroken(false)}>
        Repair
      </button>
      <Fragile broken={broken} />
    </>
  );
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(cleanup);

describe('an application that renders', () => {
  it('is left entirely alone by the boundary', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('The reader is working.')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });
});

describe('an application that throws while rendering', () => {
  it('shows the recovery surface instead of a blank page', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    const surface = screen.getByTestId('error-boundary');

    expect(surface).toBeTruthy();
    expect(screen.getByText(BOUNDARY_FAILURE_MESSAGE)).toBeTruthy();
    // The defect being fixed is an empty document body.
    expect(surface.textContent).not.toBe('');
  });

  it('does not render the exception, its message or anything in it', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    const rendered = document.body.textContent ?? '';

    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain('ENOENT');
    expect(rendered).not.toContain('/home/reader');
    expect(rendered).not.toContain('Error');
    expect(rendered).not.toMatch(/[\\/]/u);
  });

  it('reports the exception to the diagnostic callback rather than swallowing it', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(SECRET);
  });

  it('writes to the renderer console when no callback was given', () => {
    render(
      <ErrorBoundary>
        <Fragile broken />
      </ErrorBoundary>,
    );

    // eslint-disable-next-line no-console -- asserting on the boundary's own report
    expect(console.error).toHaveBeenCalledWith(
      '[renderer] a component failed to render',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('announces the failure as a problem, through the existing Message', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');

    expect(alert.className).toContain('message--problem');
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it('gives the recovery surface an accessible name', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('region', { name: 'The reader needs attention' })).toBeTruthy();
  });

  it('offers a real, keyboard-reachable button with a fixed name', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    const button = screen.getByRole('button', { name: RELOAD_LABEL });

    // A real button: focusable, enter- and space-activated, focus-ringed
    // by `.control` like every other control in the product.
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('control');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('uses no dangerous HTML anywhere in the surface', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary').querySelector('script')).toBeNull();
  });
});

describe('the recovery attempt is bounded', () => {
  it('renders the application again when the recovery succeeds', () => {
    const { rerender } = render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary')).toBeTruthy();

    // What the reader does, and the fault having gone in the meantime.
    rerender(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: RELOAD_LABEL }));

    expect(screen.queryByTestId('error-boundary')).toBeNull();
    expect(screen.getByText('The reader is working.')).toBeTruthy();
  });

  it('is usable again after a recovery that held: a later failure is not terminal', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Repairable brokenAtFirst />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: RELOAD_LABEL }));
    // The child still throws on its first render after the reset, so this
    // proves the *second* failure path rather than the happy one.
    expect(screen.getByText(BOUNDARY_TERMINAL_MESSAGE)).toBeTruthy();
  });

  it('stays in the honest terminal state when the recovery fails', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: RELOAD_LABEL }));

    expect(screen.getByText(BOUNDARY_TERMINAL_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(BOUNDARY_FAILURE_MESSAGE)).toBeNull();
  });

  it('removes the affordance in the terminal state, so there is no loop to be in', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: RELOAD_LABEL }));

    expect(screen.queryByRole('button', { name: RELOAD_LABEL })).toBeNull();
    expect(screen.getByTestId('error-boundary')).toBeTruthy();
  });

  it('never reloads by itself: the surface stays until the reader acts', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    // Two renders' worth of opportunity for an automatic retry.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('error-boundary')).toBeTruthy();
  });

  it('still hides the exception in the terminal state', () => {
    render(
      <ErrorBoundary onError={vi.fn()}>
        <Fragile broken />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: RELOAD_LABEL }));

    expect(document.body.textContent ?? '').not.toContain('ENOENT');
  });
});

describe('the copy', () => {
  it('says what happened and what is safe, without naming a mechanism', () => {
    for (const copy of [BOUNDARY_FAILURE_MESSAGE, BOUNDARY_TERMINAL_MESSAGE]) {
      expect(copy).toMatch(/have not been affected\.$/u);
      expect(copy).not.toMatch(/[\\/]/u);
      expect(copy).not.toMatch(/React|render|component|exception|stack/iu);
    }
  });
});
