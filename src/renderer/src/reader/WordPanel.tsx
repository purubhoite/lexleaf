import type { ReactElement } from 'react';

import { Message } from '../ui/Message';

import type { WordInteraction } from './interaction/resolveInteraction';

/**
 * Shows what the reader's last interaction resolved to.
 *
 * Until 6.4 this panel carried the whole developer-facing view of a word —
 * the raw JSON, the lookup form, the character range and the timing — as
 * permanent chrome beside the document (W7). Those fields were not removed:
 * they moved, unchanged, into the one developer-diagnostics disclosure
 * (`DeveloperDiagnostics`), which is closed when the reader starts. What is
 * left here is the one thing a reader rather than a developer wants from
 * this panel: which word was identified, or why none was.
 *
 * It is a polite live region: a reader using a screen reader hears the word
 * without the focus moving.
 */

export interface WordPanelProps {
  readonly interaction: WordInteraction | null;
  /** True once the user has pointed at, selected or walked to something. */
  readonly interacted: boolean;
}

export const WordPanel = ({ interaction, interacted }: WordPanelProps): ReactElement => {
  const hit = interaction?.hit ?? null;
  const word = hit?.kind === 'word' ? hit.word : null;
  const reason = hit?.kind === 'miss' ? hit.reason : null;

  return (
    /*
      6.5, Part 2. The live region that used to be this section moved to
      `WordAnnouncement`, outside every collapsible container: 6.4 put this
      panel inside a `hidden` div, and a hidden live region says nothing.
      What is left here is the visible text, which is what a panel is for.
    */
    <section aria-label="Identified word" className="word">
      {word === null ? (
        <Message kind="empty" testId="word-empty">
          {interacted ? 'No word here.' : 'Point at a word, or press Alt with the arrow keys.'}
          {interacted && reason !== null && <span className="word__reason"> ({reason})</span>}
        </Message>
      ) : (
        <p className="word__headline" data-testid="word-display">
          {word.display}
        </p>
      )}
    </section>
  );
};
