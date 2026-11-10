import { useState, type ReactElement } from 'react';

import type { WordInteraction } from './interaction/resolveInteraction';
import type { SelfCheckReport } from './pdf/selfCheck';

/**
 * Developer instrumentation, behind one disclosure (W7, CTL-9).
 *
 * Everything in here was permanent primary chrome until 6.4: the raw word
 * JSON, the lookup form, the character range, the per-interaction timing,
 * the document and page render timings, the live-page count, the text-layer
 * overlay and the text-layer self-check all sat beside the document at all
 * times, in a reading application. None of it is deleted and none of it is
 * weakened — it is collected into a single `<details>` that is closed when
 * the reader starts, so the default view is the document and the word.
 *
 * Two properties this component must keep:
 *
 * - Every `data-testid` that existed at `milestone-5` is still rendered
 *   (AC 27). A closed `<details>` hides its content visually but keeps it in
 *   the DOM and in the document's test surface, so moving a field in here
 *   changes where it is, never whether it exists.
 * - The disclosure is a native details element with a native summary and no
 *   ARIA of its own, like the other two in the application (A11Y-14).
 *
 * 6.8 adds the preference that decides whether it starts expanded
 * (ADR-031). It changes one thing and nothing else: the initial `open`
 * state of the same native disclosure. No diagnostic output is added,
 * none is moved back out, and the reader can still open and close it by
 * hand at any time — "on" means "already open", not "held open".
 */

export interface DeveloperDiagnosticsProps {
  /** Whether the disclosure starts expanded (the stored preference). */
  readonly startOpen?: boolean;
  readonly interaction: WordInteraction | null;
  readonly loadMilliseconds: number;
  readonly renderMilliseconds: number | null;
  readonly pageCount: number;
  readonly pagesMeasured: number;
  readonly pagesLive: number;
  readonly showTextLayer: boolean;
  readonly onShowTextLayerChange: (showTextLayer: boolean) => void;
  readonly onRunSelfCheck: () => void;
  readonly selfCheck: SelfCheckReport | null;
}

const SOURCE_LABEL: Record<WordInteraction['source'], string> = {
  pointer: 'pointer',
  selection: 'selection',
  keyboard: 'keyboard',
};

export const DeveloperDiagnostics = ({
  startOpen = false,
  interaction,
  loadMilliseconds,
  renderMilliseconds,
  pageCount,
  pagesMeasured,
  pagesLive,
  showTextLayer,
  onShowTextLayerChange,
  onRunSelfCheck,
  selfCheck,
}: DeveloperDiagnosticsProps): ReactElement => {
  const hit = interaction?.hit ?? null;
  const word = hit?.kind === 'word' ? hit.word : null;

  /*
   * The disclosure is controlled rather than left to the DOM, because two
   * things may open it: the stored preference, and the reader. Both have
   * to work. `onToggle` records what the reader did; the comparison below
   * is React's "adjust state when a prop changes" pattern, which follows
   * a *change* of the preference without overriding the reader on every
   * other render — and without an effect, which would render once with
   * the stale value first.
   */
  const [open, setOpen] = useState(startOpen);
  const [appliedPreference, setAppliedPreference] = useState(startOpen);

  if (appliedPreference !== startOpen) {
    setAppliedPreference(startOpen);
    setOpen(startOpen);
  }

  return (
    <details
      className="diagnostics"
      data-testid="developer-diagnostics"
      open={open}
      onToggle={(event): void => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="disclosure__summary">Developer diagnostics</summary>

      <div className="diagnostics__body">
        {/*
          The three forms the specification distinguishes — what the page
          shows, what is displayed to the reader, and what a lookup would
          use — stay separate, because conflating them is the mistake this
          subsystem has to rule out. They are developer-facing, which is
          why they are here and not beside the document.
        */}
        <dl className="word__details">
          <dt>Raw</dt>
          <dd data-testid="word-raw">{word === null ? '—' : JSON.stringify(word.raw)}</dd>
          <dt>Lookup form</dt>
          <dd data-testid="word-normalized">{word === null ? '—' : word.normalized}</dd>
          <dt>Rejoined across lines</dt>
          <dd>{word === null ? '—' : word.joinedAcrossLines ? 'yes' : 'no'}</dd>
          <dt>Page</dt>
          <dd data-testid="word-page">{interaction?.pageNumber ?? '—'}</dd>
          <dt>Range in page text</dt>
          <dd>{word === null ? '—' : `${String(word.start)}–${String(word.end)}`}</dd>
        </dl>

        {interaction !== null && (
          <p className="word__timing">
            {SOURCE_LABEL[interaction.source]} → word: {interaction.milliseconds.toFixed(2)} ms
          </p>
        )}

        <dl className="reader__stats">
          <dt>Document opened in</dt>
          <dd>{loadMilliseconds} ms</dd>
          <dt>Last page rendered in</dt>
          <dd>{renderMilliseconds === null ? '—' : `${String(renderMilliseconds)} ms`}</dd>
          <dt>Pages</dt>
          <dd>{pageCount}</dd>
          <dt>Pages measured</dt>
          <dd>{pagesMeasured}</dd>
          <dt>Pages live</dt>
          <dd>{pagesLive}</dd>
        </dl>

        <label className="checkbox">
          <input
            type="checkbox"
            className="checkbox__input"
            checked={showTextLayer}
            onChange={(event): void => {
              onShowTextLayerChange(event.target.checked);
            }}
          />
          <span>Show text layer</span>
        </label>

        <button type="button" className="control" onClick={onRunSelfCheck}>
          Check text layer
        </button>

        {selfCheck !== null && (
          <p className="reader__selfcheck" role="status">
            Text layer check: {selfCheck.checked} pages, {selfCheck.mismatches.length} mismatches,{' '}
            {selfCheck.milliseconds} ms
            {selfCheck.mismatches[0] !== undefined && (
              <span> — first: {selfCheck.mismatches[0].firstDifference}</span>
            )}
          </p>
        )}
      </div>
    </details>
  );
};
