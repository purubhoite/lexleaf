/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { IdentifiedWord } from '@core/word/types';
import type { WordInteraction } from './interaction/resolveInteraction';
import { WordAnnouncement } from './WordAnnouncement';
import { WordPanel } from './WordPanel';

/**
 * The identified-word announcement (6.5, Part 2; 6.4 audit, C4 and C3).
 *
 * Two failures are being guarded against here, and they are different
 * failures.
 *
 * C4 is the one 6.4 shipped: the announcement lived on a section that 6.4
 * put inside a `hidden` container, so below the side-panel breakpoint —
 * which is how the application starts at its minimum window — nothing was
 * announced at all. That half is tested against the real reader in
 * `states.test.tsx`, where the panel can actually be collapsed.
 *
 * C3 is the one the 6.4 *test suite* shipped: the assertion that no
 * developer instrumentation reaches this announcement only ever ran with
 * no word identified, so it passed by rendering the empty state and
 * looking at it. Every test below that makes a claim about the
 * announcement's content renders a word first, and the mutation evidence
 * in the completion report shows that putting a timing back into the word
 * branch now fails.
 */

const identified = (word: string): IdentifiedWord => ({
  raw: `${word},`,
  display: word,
  normalized: word.toLowerCase(),
  joinedAcrossLines: true,
  start: 11,
  end: 11 + word.length,
});

const interactionFor = (word: string | null): WordInteraction => ({
  source: 'pointer',
  documentId: 'doc-1',
  pageNumber: 7,
  generation: 1,
  hit:
    word === null
      ? { kind: 'miss', reason: 'not-a-word' }
      : { kind: 'word', word: identified(word), characterIndex: 3 },
  textIndex: 11,
  milliseconds: 4.25,
});

const announcement = (): HTMLElement => screen.getByTestId('word-announcement');

afterEach(() => {
  cleanup();
});

describe('the identified word is announced (A11Y, 6.5 Part 2)', () => {
  it('says the word once a word has actually been identified', () => {
    render(<WordAnnouncement interaction={interactionFor('lighthouse')} />);

    expect(announcement().textContent).toBe('lighthouse');
  });

  it('is a polite live region, not a focus stop and not visible chrome', () => {
    render(<WordAnnouncement interaction={interactionFor('lighthouse')} />);

    const node = announcement();

    expect(node.getAttribute('role')).toBe('status');
    expect(node.className).toBe('visually-hidden');
    expect(node.getAttribute('tabindex')).toBeNull();
    expect(node.closest('[hidden]')).toBeNull();
  });

  it('exists before anything has been identified, so the region can be watched', () => {
    render(<WordAnnouncement interaction={null} />);

    // A live region that appears at the moment it has something to say is
    // the bug this shape avoids: screen readers announce changes inside a
    // region they were already watching.
    expect(announcement().textContent).toBe('');
  });

  it('says nothing when the pointer landed on something that is not a word', () => {
    render(<WordAnnouncement interaction={interactionFor(null)} />);

    expect(announcement().textContent).toBe('');
  });

  it('carries no timing, no raw form and no page — the real branch, not the empty one', () => {
    // C3. The interaction deliberately carries a 4.25 ms measurement, a
    // raw form that differs from the display form, a lookup form, a page
    // number and a character range. None of it belongs in a reader's ear.
    render(<WordAnnouncement interaction={interactionFor('Lighthouse')} />);

    const spoken = announcement().textContent ?? '';

    expect(spoken).toBe('Lighthouse');
    expect(spoken).not.toContain('ms');
    expect(spoken).not.toContain('4.25');
    expect(spoken).not.toContain('Lighthouse,');
    expect(spoken).not.toContain('lighthouse');
    expect(spoken).not.toContain('7');
    expect(spoken).not.toContain('{');
  });

  it('does not say the same word twice when the reader re-renders', () => {
    const { rerender } = render(<WordAnnouncement interaction={interactionFor('harbour')} />);
    const first = announcement();

    rerender(<WordAnnouncement interaction={interactionFor('harbour')} />);

    // Same node, same text: there is no change for a screen reader to
    // announce, which is what "avoid repeating unchanged announcements"
    // means in a live region.
    expect(announcement()).toBe(first);
    expect(announcement().textContent).toBe('harbour');
  });

  it('does say the next word when the reader moves on', () => {
    const { rerender } = render(<WordAnnouncement interaction={interactionFor('harbour')} />);
    const first = announcement();

    rerender(<WordAnnouncement interaction={interactionFor('jetty')} />);

    expect(announcement()).toBe(first);
    expect(announcement().textContent).toBe('jetty');
  });
});

describe('the panel that used to announce no longer does (one authoritative region)', () => {
  it('shows the word without being a live region itself', () => {
    render(<WordPanel interaction={interactionFor('lighthouse')} interacted />);

    const panel = screen.getByRole('region', { name: 'Identified word' });

    expect(screen.getByTestId('word-display').textContent).toBe('lighthouse');
    expect(panel.getAttribute('aria-live')).toBeNull();
    expect(panel.querySelector('[role="status"]')).toBeNull();
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps its empty state, and keeps it silent', () => {
    render(<WordPanel interaction={null} interacted={false} />);

    const empty = screen.getByTestId('word-empty');

    expect(empty.textContent).toContain('Point at a word');
    expect(empty.getAttribute('role')).toBeNull();
  });

  it('still reports why a miss was a miss, for the reader who can see it', () => {
    render(<WordPanel interaction={interactionFor(null)} interacted />);

    expect(screen.getByTestId('word-empty').textContent).toContain('not-a-word');
  });
});
