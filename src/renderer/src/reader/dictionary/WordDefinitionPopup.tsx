import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';

import type { DictionaryResult, DictionarySense } from '@core/dictionary/types';

import { Message } from '../../ui/Message';
import { ExplainControl } from '../ai/ExplainControl';
import type { ExplainControl as ExplainControlState } from '../ai/useExplainInContext';

import {
  POPUP_MIN_HEIGHT,
  placePopup,
  popupWidth,
  type ViewportRect,
  type ViewportSize,
} from './placePopup';

/**
 * The definition popup.
 *
 * It is a small, dismissible panel anchored to the word the reader
 * double-clicked, not a page, a sidebar or a modal. Four things decide its
 * whole design:
 *
 * - **it must not move the document.** It is positioned over the page in
 *   viewport coordinates and flips above the word rather than scrolling;
 * - **it must be dismissible without thought.** Escape, a click outside, or
 *   anything that changes what is on screen closes it;
 * - **it must be honest.** A missing pronunciation leaves no gap, a fallback
 *   says which headword answered, and an unavailable dictionary says only
 *   that;
 * - **it must be reachable from the keyboard.** Focus moves in when it
 *   opens and returns to where it was when it closes, and Tab stays inside
 *   while it is open — but Escape always leaves.
 */

/**
 * The save control, decided elsewhere.
 *
 * The popup renders what it is given and reports clicks; whether a word is
 * already saved, what saving means here, and what to do when the store
 * refuses are all the hook's business.
 */
export interface SaveControl {
  readonly state: 'unknown' | 'not-saved' | 'saved-elsewhere' | 'saved-here' | 'working';
  readonly otherPlaces: number;
  readonly error: string | null;
  readonly onSave: () => void;
  readonly onRemove: () => void;
}

/**
 * What assistive technology is told when a lookup settles.
 *
 * Milestone 2 deferred this ("announcement of the result ... belongs to
 * Milestone 6", D6) and nothing has announced a result since: the only live
 * node was the "Looking up" status, and it was removed at the moment the
 * definition appeared, so a screen-reader user heard the lookup start and
 * never heard it finish (W13).
 *
 * The wording is deliberately a summary, not the definition. The senses are
 * already in the dialog and the reader can navigate to them; repeating the
 * first sense here would say everything twice. Nothing about the provider,
 * the dataset path or the lookup mechanism is said.
 */
export const announceResult = (result: DictionaryResult | null, displayWord: string): string => {
  if (result === null) {
    return '';
  }

  switch (result.status) {
    case 'found':
    case 'partial': {
      const count = result.senses.length;

      return `${result.headword}: definition available, ${String(count)} ${
        count === 1 ? 'sense' : 'senses'
      }.`;
    }
    case 'not-found':
      return `No dictionary entry found for ${displayWord}.`;
    default:
      return 'The dictionary could not be loaded.';
  }
};

export interface WordDefinitionPopupProps {
  /** The word's rectangle, in viewport coordinates. */
  readonly anchor: ViewportRect;
  /** The word as the page shows it. */
  readonly displayWord: string;
  readonly loading: boolean;
  readonly result: DictionaryResult | null;
  readonly onClose: () => void;
  /** Absent when there is nothing to save, as for an unavailable dictionary. */
  readonly save?: SaveControl;
  /**
   * Contextual explanation, when a provider is configured.
   *
   * Offered for an entry that was found, one shown for another headword,
   * and a word with no entry at all — but never when the dictionary itself
   * could not be loaded, because then there is no definition for an
   * explanation to be secondary to.
   */
  readonly explain?: ExplainControlState;
  /** Injectable for tests; defaults to the window. */
  readonly viewport?: ViewportSize;
}

/**
 * The save button.
 *
 * Three labels, each saying what pressing it will do: save a word that is
 * not saved, add this place to a word that is saved from somewhere else,
 * or - when it already says "Saved" - take the word away again.
 */
const SaveButton = ({ save }: { readonly save: SaveControl }): ReactElement | null => {
  if (save.state === 'unknown') {
    return null;
  }

  const saved = save.state === 'saved-here';
  const label =
    save.state === 'saved-elsewhere'
      ? 'Save from here'
      : saved
        ? 'Saved'
        : save.state === 'working'
          ? 'Working…'
          : 'Save word';

  return (
    <div className="dictionary-popup__save">
      <button
        type="button"
        className={
          saved ? 'control dictionary-popup__saved' : 'control dictionary-popup__save-button'
        }
        data-testid="vocabulary-save"
        data-state={save.state}
        disabled={save.state === 'working'}
        aria-pressed={saved}
        onClick={saved ? save.onRemove : save.onSave}
      >
        {label}
      </button>

      {save.state === 'saved-here' && save.otherPlaces > 0 && (
        <p className="dictionary-popup__save-note" data-testid="vocabulary-other-places">
          Also saved from {String(save.otherPlaces)} other{' '}
          {save.otherPlaces === 1 ? 'place' : 'places'}.
        </p>
      )}

      {save.error !== null && (
        <p className="dictionary-popup__save-error" role="alert" data-testid="vocabulary-error">
          {save.error}
        </p>
      )}
    </div>
  );
};

/** Senses shown before "More senses". */
const INITIAL_SENSES = 3;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, details > summary, [tabindex]:not([tabindex="-1"])';

const senseKey = (sense: DictionarySense, position: number): string =>
  `${String(position)}:${sense.partOfSpeech}:${sense.definition.slice(0, 24)}`;

/** The viewport, read once per resize rather than once per render. */
const readViewport = (): ViewportSize =>
  typeof window === 'undefined'
    ? { width: 0, height: 0 }
    : { width: window.innerWidth, height: window.innerHeight };

/**
 * The height the popup *wants*, which is not the height it currently has.
 *
 * Measuring the rendered box would feed the placement its own output: a
 * popup clamped to the room above is shorter, a shorter popup fits below,
 * and the next measurement flips it back. The scroll height of the content
 * does not move when `max-height` changes, so placement converges after one
 * pass. The difference between the popup's border box and its client box is
 * added back because `max-height` is applied to the border box.
 */
const naturalHeight = (popup: HTMLElement, content: HTMLElement): number =>
  content.scrollHeight + (popup.offsetHeight - popup.clientHeight);

const SenseView = ({ sense }: { readonly sense: DictionarySense }): ReactElement => (
  <li className="dictionary-popup__sense">
    <p className="dictionary-popup__definition">
      <span className="dictionary-popup__part">{sense.partOfSpeech}</span> {sense.definition}
    </p>
    {sense.examples.length > 0 && (
      <p className="dictionary-popup__example">“{sense.examples[0]}”</p>
    )}
    {sense.synonyms.length > 0 && (
      <p className="dictionary-popup__synonyms">Also: {sense.synonyms.join(', ')}</p>
    )}
    {sense.source === 'application' && (
      <p className="dictionary-popup__origin">Grammar note written for this application.</p>
    )}
  </li>
);

export const WordDefinitionPopup = ({
  anchor,
  displayWord,
  loading,
  result,
  onClose,
  save,
  explain,
  viewport,
}: WordDefinitionPopupProps): ReactElement => {
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<Element | null>(null);
  /** `null` until the popup has been measured. */
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [windowSize, setWindowSize] = useState<ViewportSize>(readViewport);

  const size: ViewportSize = viewport ?? windowSize;

  /*
   * Before measurement the popup is assumed to be short, not viewport-tall
   * (W11). The old guess made the very first placement pessimistic: a popup
   * assumed to be 900px high does not fit below anything, so it opened
   * above the word and jumped back down as soon as it was measured. A
   * minimum-height guess puts it where it will almost always end up.
   */
  const placement = placePopup(anchor, height ?? POPUP_MIN_HEIGHT, size);

  const measure = useCallback((): void => {
    const popup = container.current;
    const inner = content.current;

    if (popup === null || inner === null) {
      return;
    }

    const natural = naturalHeight(popup, inner);

    // jsdom reports zero for every box; leaving the estimate in place is
    // more honest than placing against a height that was never measured.
    setHeight((previous) =>
      natural > 0 && (previous === null || Math.abs(natural - previous) >= 1) ? natural : previous,
    );
  }, []);

  /*
   * Measured in a layout effect, so the browser never paints the estimate:
   * React runs this, the state change re-renders, and only then is the
   * frame drawn. The dependency list names every content change the popup
   * can see coming — the result itself, the loading flag, "More senses",
   * the save control's state and every step of an explanation — so those
   * are all repositioned before they are visible (AC 14).
   */
  useLayoutEffect(() => {
    measure();
  }, [
    measure,
    result,
    loading,
    expanded,
    save?.state,
    save?.error,
    explain?.state,
    explain?.explanation,
    explain?.message,
    anchor,
    size.width,
    size.height,
  ]);

  /*
   * And a ResizeObserver for the content changes nothing can name: a font
   * finishing, text re-wrapping after the window narrowed, a future child
   * component growing. This is what replaces the old fixed dependency list
   * as the thing that actually guarantees W10 — the list above is an
   * optimisation that keeps the common cases out of the next frame.
   */
  useLayoutEffect(() => {
    const inner = content.current;

    if (inner === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      measure();
    });

    observer.observe(inner);

    return (): void => {
      observer.disconnect();
    };
  }, [measure]);

  // The popup is positioned in viewport coordinates, so a resized window
  // moves it. Only when the viewport is not supplied by a test.
  useEffect(() => {
    if (viewport !== undefined || typeof window === 'undefined') {
      return undefined;
    }

    const onResize = (): void => {
      setWindowSize(readViewport());
    };

    window.addEventListener('resize', onResize);

    return (): void => {
      window.removeEventListener('resize', onResize);
    };
  }, [viewport]);

  // Focus moves in on open and goes back where it was on close.
  useEffect(() => {
    restoreFocusTo.current = document.activeElement;
    container.current?.focus();

    return (): void => {
      const previous = restoreFocusTo.current;

      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  // A click anywhere else is a dismissal.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const element = container.current;

      if (element !== null && event.target instanceof Node && !element.contains(event.target)) {
        onClose();
      }
    };

    window.addEventListener('pointerdown', onPointerDown);

    return (): void => {
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        // Handled here so that Escape closes the popup *first* and does not
        // also clear the reader's word or the search panel.
        event.stopPropagation();
        event.preventDefault();
        onClose();

        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const element = container.current;

      if (element === null) {
        return;
      }

      const focusable = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0] ?? element;
      const last = focusable[focusable.length - 1] ?? element;
      const active = document.activeElement;

      // Containment, not a trap: Escape always leaves, and so does a click.
      if (event.shiftKey && (active === first || active === element)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const found = result !== null && (result.status === 'found' || result.status === 'partial');
  const senses = found ? result.senses : [];
  const visible = expanded ? senses : senses.slice(0, INITIAL_SENSES);
  const headword = found ? result.headword : displayWord;
  const announcement = loading ? '' : announceResult(result, displayWord);

  return (
    <div
      /*
        Written out rather than interpolated so that the stylesheet test
        can see that both modifiers have a user: it matches class names in
        the component sources, and a name assembled at runtime is invisible
        to it. These two carried no styling at all until 6.3 (W8).
      */
      className={
        placement.placement === 'above'
          ? 'dictionary-popup dictionary-popup--above'
          : 'dictionary-popup dictionary-popup--below'
      }
      ref={container}
      role="dialog"
      aria-label={`Definition of ${displayWord}`}
      tabIndex={-1}
      data-testid="dictionary-popup"
      data-placement={placement.placement}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: `${String(placement.left)}px`,
        top: `${String(placement.top)}px`,
        width: `${String(popupWidth(size))}px`,
        maxHeight: `${String(placement.maxHeight)}px`,
      }}
    >
      {/*
        The arrow (D1/W8). It is absolutely positioned against the popup and
        sits outside its padding box, so it adds nothing to the content flow
        and cannot change the height that was just measured. `aria-hidden`
        because it is a pointer, not information: the popup is already named
        for the word it defines.

        It is drawn only when the placement found something to point at;
        when the word is off the side of the popup there is no honest place
        to put it.
      */}
      {placement.arrowLeft !== null && (
        <span
          className="dictionary-popup__arrow"
          data-testid="dictionary-popup-arrow"
          aria-hidden="true"
          style={{ left: `${String(placement.arrowLeft)}px` }}
        />
      )}

      {/*
        The scrolling half of the popup. The border, the background and the
        arrow belong to the outer element; everything that can overflow
        lives in here, because an `overflow` of anything but `visible`
        clips absolutely positioned children — including the arrow.
      */}
      <div className="dictionary-popup__scroll" ref={content}>
        <header className="dictionary-popup__header">
          <h2 className="dictionary-popup__word">{displayWord}</h2>
          <button
            type="button"
            className="control control--quiet dictionary-popup__close"
            onClick={onClose}
            aria-label="Close definition"
          >
            ×
          </button>
        </header>

        {/*
          One live region for the whole lookup, rendered unconditionally so
          that React keeps the same DOM node across the transition. A screen
          reader announces a change of content inside a live region it is
          already watching; swapping one `role="status"` element for another
          is far less reliable, and two live regions would say it twice.

          While the lookup runs this is the visible status line it has always
          been. Once a result is on screen the text is only for assistive
          technology — the definition itself is now visible — so the node
          becomes visually hidden rather than disappearing (A11Y-8).
        */}
        <p
          className={loading ? 'dictionary-popup__status' : 'visually-hidden'}
          role="status"
          data-testid="dictionary-status"
        >
          {loading ? 'Looking up…' : announcement}
        </p>

        {/*
          `announce={false}`: the status node above has already said this,
          and one event must not be announced twice (6.5, Part 3).
        */}
        {!loading && result !== null && result.status === 'unavailable' && (
          <Message
            kind="problem"
            className="dictionary-popup__status"
            testId="dictionary-unavailable"
            announce={false}
          >
            The dictionary could not be loaded.
          </Message>
        )}

        {!loading && result !== null && result.status === 'not-found' && (
          <div data-testid="dictionary-not-found">
            <Message kind="empty" className="dictionary-popup__status">
              No dictionary entry found.
            </Message>
            {/*
              D4, resolved as § 13.3 directs: the specification's second
              line is printed only when there is an "In Context" control to
              point at. With no provider configured the sentence would
              advertise something that does not exist.
            */}
            {explain !== undefined && (
              <Message kind="empty" className="dictionary-popup__status">
                {'Try "In Context".'}
              </Message>
            )}
            {/*
              A word with no entry can still be worth keeping - a name, a term
              of art, a word this dictionary does not carry - so the save
              control is offered here too, and what is stored records honestly
              that nothing was found.
            */}
            {save !== undefined && <SaveButton save={save} />}
            {explain !== undefined && <ExplainControl explain={explain} />}
          </div>
        )}

        {!loading && found && (
          <div className="dictionary-popup__body">
            {headword.toLowerCase() !== displayWord.toLowerCase() && (
              <p className="dictionary-popup__fallback" data-testid="dictionary-fallback">
                Shown for <strong>{headword}</strong>.
              </p>
            )}

            {result.pronunciations.length > 0 && (
              <p className="dictionary-popup__pronunciation">
                {result.pronunciations.map((pronunciation) => (
                  <span key={`${pronunciation.variety}:${pronunciation.value}`}>
                    {pronunciation.variety === 'unspecified' ? '' : `${pronunciation.variety} `}/
                    {pronunciation.value}/
                  </span>
                ))}
              </p>
            )}

            <ol className="dictionary-popup__senses">
              {visible.map((sense, position) => (
                <SenseView key={senseKey(sense, position)} sense={sense} />
              ))}
            </ol>

            {!expanded && senses.length > INITIAL_SENSES && (
              <button
                type="button"
                className="control dictionary-popup__more"
                onClick={(): void => {
                  setExpanded(true);
                }}
              >
                More senses ({String(senses.length - INITIAL_SENSES)})
              </button>
            )}

            {result.alsoInflectionOf.length > 0 && (
              <p className="dictionary-popup__shadowing" data-testid="dictionary-shadowing">
                Also an inflected form of{' '}
                {result.alsoInflectionOf.map((base, position) => (
                  <span key={base}>
                    {position > 0 ? ', ' : ''}
                    <strong>{base}</strong>
                  </span>
                ))}
                .
              </p>
            )}

            {save !== undefined && <SaveButton save={save} />}
            {explain !== undefined && <ExplainControl explain={explain} />}

            <details className="dictionary-popup__attribution">
              <summary className="disclosure__summary">Dictionary source</summary>
              <p>
                {result.attribution.datasetName} {result.attribution.release}
              </p>
              <ul>
                {result.attribution.credits.map((credit) => (
                  <li key={credit}>{credit}</li>
                ))}
              </ul>
              <ul>
                {result.attribution.licences.map((licence) => (
                  <li key={licence.url}>
                    {licence.name} — {licence.url}
                  </li>
                ))}
              </ul>
              <p>{result.attribution.modificationStatement}</p>
            </details>
          </div>
        )}
      </div>
    </div>
  );
};
