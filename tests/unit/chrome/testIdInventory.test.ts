import { describe, expect, it } from 'vitest';

import { componentSources } from '../styles/stylesheetSource';

/**
 * AC 27: every `data-testid` that existed at `milestone-5` still exists and
 * still identifies the same thing.
 *
 * This is the acceptance gate for 6.4, and it exists because of what 6.4
 * does: W7's developer instrumentation was *moved*, from permanent chrome
 * beside the document into one disclosure. Moving markup is exactly how a
 * hook that a test, a runtime probe or a future integration test depends on
 * disappears without anyone noticing — the suite still passes, because the
 * test that used it was deleted in the same commit.
 *
 * The inventory below was taken from the `milestone-5` tag itself:
 *
 *   git grep -h -o 'data-testid="[^"]*"' milestone-5 -- src/renderer
 *
 * It is a frozen list, not a snapshot regenerated from the working tree: a
 * snapshot would agree with whatever the code currently does, which is the
 * opposite of what AC 27 asks. Identifiers added after `milestone-5` are
 * listed separately, so the two groups can be reasoned about apart — the
 * first may never shrink, the second is allowed to grow.
 */

/** The 39 identifiers rendered at `milestone-5`. None of these may go. */
const MILESTONE_5_TEST_IDS = [
  'dictionary-fallback',
  'dictionary-not-found',
  'dictionary-popup',
  'dictionary-shadowing',
  'dictionary-unavailable',
  'explain-control',
  'explain-in-context',
  'explanation-cancel',
  'explanation-disclosure',
  'explanation-error',
  'explanation-loading',
  'explanation-previous',
  'explanation-text',
  'explanation-truncated',
  'library',
  'library-card',
  'library-document',
  'library-empty',
  'library-failed',
  'library-loading',
  'library-more',
  'library-occurrences',
  'library-search',
  'library-sort',
  'library-toggle',
  'library-truncated',
  'library-undo',
  'library-undo-failed',
  'library-unreadable',
  'navigation-notice',
  'reader-surface',
  'vocabulary-error',
  'vocabulary-other-places',
  'vocabulary-save',
  'word-display',
  'word-empty',
  'word-normalized',
  'word-page',
  'word-raw',
] as const;

/** Added since: three in 6.2 and 6.3, one in 6.4, seven in 6.8, one in M7.2. */
const ADDED_AFTER_MILESTONE_5 = [
  // Highlights and notes, bookmarks and "back", the sidebar with its page
  // thumbnails, the page views and rotation, printing, and reading aloud.
  // The colour buttons and the sidebar tabs are named from their values
  // (`highlight-yellow`, `sidebar-tab-notes`) and so are not listed.
  'annotation-popup',
  'annotations-write-failed',
  'bookmark-entry',
  'bookmark-toggle',
  'bookmarks',
  'dictionary-listen',
  'go-back',
  'highlight-copy',
  'highlight-listen',
  'highlight-note',
  'highlight-note-field',
  'highlight-remove',
  'note-entry',
  'notes',
  'notes-export',
  'notes-export-result',
  'print',
  'print-dialog',
  'print-from',
  'print-go',
  'print-progress',
  'print-to',
  'read-aloud',
  'read-aloud-unavailable',
  'rotate',
  'sidebar',
  'thumbnail',
  'thumbnails',
  'view-mode',
  // 0.2.3's interface work: the side panel, the shared notice area, the
  // first-book tip, reading mode, the drop target, the page colour, About
  // in the settings, and the popup's separate "saved" and "remove".
  'side-panel',
  'notices',
  'lookup-hint',
  'reading-mode-toggle',
  'exit-reading-mode',
  'drop-target',
  'setting-page-tint',
  'about',
  'vocabulary-saved',
  'vocabulary-remove',
  'skip-to-document',
  'dictionary-popup-arrow',
  'dictionary-status',
  'developer-diagnostics',
  'word-announcement',
  // 6.8's settings surface: the panel, the two ways in and out of it, and
  // one identifier per preference group. The individual radio buttons
  // deliberately have none — they are reached by role and accessible
  // name, which is the thing a reader's keyboard and a screen reader use.
  'settings',
  'settings-toggle',
  'settings-close',
  'setting-appearance',
  'setting-reduce-motion',
  'setting-default-zoom',
  'setting-developer-diagnostics',
  // M7.2: the one notice a session can raise when reading state stops
  // reaching the disk. It is the shared `Message`, so the identifier
  // arrives through the `testId` prop rather than the attribute.
  'persistence-notice',
  // M7.1: the notice a rebuilt renderer raises once, and the surface the
  // error boundary puts in place of an application that could not render.
  'recovery-notice',
  'error-boundary',
  'vocabulary-recovery',
  'recovery-empty',
  // The update notice: the one in the shell, and in the settings screen
  // its group, its button and the line that reports a check.
  'update-notice',
  'setting-updates',
  'update-check-now',
  'update-status',
  // Exporting saved words: one button per format and the line that says
  // what happened.
  'library-export-csv',
  'library-export-anki',
  'library-export-status',
  // The table of contents: its button, the panel and an entry in it.
  'outline-toggle',
  'outline',
  'outline-entry',
  // The notice a scanned document gets, once, for the whole document.
  'scan-notice',
  // Reporting a problem from the settings screen.
  'setting-report-problem',
  'report-problem',
  'report-problem-failed',
] as const;

/**
 * Every identifier the renderer can put in the DOM.
 *
 * Two spellings reach `data-testid`: the attribute itself, and the
 * `testId` prop of the shared `Message` component, which forwards it
 * (6.5). Both are literal strings in a component source — a component
 * that computed an identifier would be invisible here, and that is a
 * thing not to start doing.
 */
const rendered = (): Set<string> =>
  new Set(
    [...componentSources().matchAll(/(?:data-testid|testId)="([^"]+)"/g)].map(
      (match) => match[1] ?? '',
    ),
  );

describe('the data-testid inventory (AC 27)', () => {
  it('still renders every identifier that existed at milestone-5', () => {
    const present = rendered();
    const missing = MILESTONE_5_TEST_IDS.filter((id) => !present.has(id));

    expect(missing).toStrictEqual([]);
  });

  it('has an empty inventory diff: nothing added is undeclared', () => {
    const declared = new Set<string>([...MILESTONE_5_TEST_IDS, ...ADDED_AFTER_MILESTONE_5]);
    const undeclared = [...rendered()].filter((id) => !declared.has(id)).sort();

    // A new identifier is not a failure; an *unrecorded* one is. The diff
    // against milestone-5 has to stay something a reviewer can read.
    expect(undeclared).toStrictEqual([]);
  });

  it('counts the milestone-5 inventory, so the list cannot be quietly trimmed', () => {
    expect(new Set(MILESTONE_5_TEST_IDS).size).toBe(39);
  });

  it('finds the identifiers the 6.4 move put inside a closed disclosure', () => {
    const present = rendered();

    // The five word fields are the ones 6.4 actually moved. Spelling them
    // out means the general rule above cannot be satisfied by a stale copy
    // of the panel left behind somewhere.
    for (const id of ['word-display', 'word-empty', 'word-raw', 'word-normalized', 'word-page']) {
      expect(present.has(id)).toBe(true);
    }
  });
});
