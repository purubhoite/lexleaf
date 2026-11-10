import type { ReactElement } from 'react';

import type { WordInteraction } from './interaction/resolveInteraction';

/**
 * The single authoritative announcement of the word under the pointer.
 *
 * It used to be the `aria-live` on `WordPanel`'s section. 6.4 made the
 * reading-details panel collapsible and put the panel's contents inside a
 * `hidden` container, which is correct for everything in there except a
 * live region: a `hidden` live region is inert, so below the side-panel
 * breakpoint — including at the minimum supported window, where the panel
 * starts collapsed — the identified word stopped being announced at all.
 * The 6.4 acceptance audit recorded that as condition C4.
 *
 * The fix is placement, not duplication. The announcement moved out here,
 * a visually hidden node that lives outside every collapsible container,
 * and `WordPanel` kept the visible text and gave up its live region. There
 * is exactly one live node for this event.
 *
 * What it says is the word and nothing else: no timing, no raw JSON, no
 * lookup form, no page or offset. Those are developer instrumentation and
 * they live in the diagnostics disclosure (6.4). What it deliberately does
 * not say is the definition — that belongs to the popup's own status node,
 * which announces "headword: definition available, N senses." when a
 * lookup settles. Two regions, two different events, no overlap.
 */

export interface WordAnnouncementProps {
  readonly interaction: WordInteraction | null;
}

export const WordAnnouncement = ({ interaction }: WordAnnouncementProps): ReactElement => {
  const hit = interaction?.hit ?? null;
  const word = hit?.kind === 'word' ? hit.word : null;

  return (
    /*
      Rendered unconditionally, and always the same node: a screen reader
      announces a change of content inside a region it is already watching,
      so the node must outlive the change. Re-identifying the same word
      writes the same string, React leaves the text node alone, and nothing
      is said a second time.
    */
    <p className="visually-hidden" role="status" data-testid="word-announcement">
      {word === null ? '' : word.display}
    </p>
  );
};
