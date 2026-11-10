/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Message, type MessageKind } from './Message';

/**
 * The shared state presentation (6.5, Part 1; investigation § 5.8, ST-2).
 *
 * The component exists to make the live-region decision once instead of
 * six times, so that is what is tested: which role each kind carries, and
 * that the one escape hatch is narrow enough to be safe. The rest of the
 * suite then tests that each surface asks for the right kind.
 */

afterEach(() => {
  cleanup();
});

const KINDS: MessageKind[] = ['info', 'busy', 'problem', 'empty'];

describe('the shared message decides the live region once (ST-2)', () => {
  it('announces work and news politely', () => {
    render(<Message kind="busy">Looking…</Message>);
    render(<Message kind="info">Moved on.</Message>);

    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces a failure assertively', () => {
    render(<Message kind="problem">That did not work.</Message>);

    expect(screen.getByRole('alert').textContent).toBe('That did not work.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never gives one message both roles', () => {
    for (const kind of KINDS) {
      cleanup();
      render(<Message kind={kind}>Text.</Message>);

      const roles = [screen.queryByRole('status'), screen.queryByRole('alert')].filter(
        (node) => node !== null,
      );

      expect(roles.length).toBeLessThanOrEqual(1);
    }
  });

  it('leaves an empty state silent, because it is content rather than news', () => {
    render(<Message kind="empty">Nothing here yet. Open a PDF to begin.</Message>);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Nothing here yet/).textContent).toContain('Open a PDF');
  });

  it('can be silenced where another live region already speaks', () => {
    // The dictionary popup keeps one status node for the whole lookup
    // (6.2, A11Y-8). A second region repeating it would say the same
    // thing twice, so the visible line beside it opts out of announcing.
    render(
      <Message kind="problem" announce={false}>
        The dictionary could not be loaded.
      </Message>,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/could not be loaded/)).toBeDefined();
  });

  it('still looks like a failure when it is silenced', () => {
    render(
      <Message kind="problem" announce={false} testId="quiet">
        Nope.
      </Message>,
    );

    expect(screen.getByTestId('quiet').className).toContain('message--problem');
  });
});

describe('what it puts in the DOM', () => {
  it('carries one kind class per kind, and the shared one always', () => {
    for (const kind of KINDS) {
      cleanup();
      render(
        <Message kind={kind} testId="message">
          Text.
        </Message>,
      );

      expect(screen.getByTestId('message').className).toBe(`message message--${kind}`);
    }
  });

  it('appends a surface class for layout without losing its own', () => {
    render(
      <Message kind="busy" className="dictionary-popup__status" testId="message">
        Generating…
      </Message>,
    );

    expect(screen.getByTestId('message').className).toBe(
      'message message--busy dictionary-popup__status',
    );
  });

  it('omits data-testid entirely when none was asked for', () => {
    render(<Message kind="info">Text.</Message>);

    expect(screen.getByRole('status').hasAttribute('data-testid')).toBe(false);
  });
});
