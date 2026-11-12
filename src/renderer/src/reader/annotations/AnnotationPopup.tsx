import { useEffect, useRef, type ReactElement } from 'react';

import {
  HIGHLIGHT_COLOURS,
  MAX_NOTE_LENGTH,
  type Highlight,
  type HighlightColour,
} from '@core/annotations/annotations';

import { Icon } from '../../ui/Icon';

/**
 * The small bar that appears by a selection, or by a highlight that has
 * been clicked.
 *
 * By a fresh selection it offers the four colours, a note, reading the
 * words aloud and copying them. By an existing highlight it shows the
 * same colours with the current one marked, the note to edit, and a way
 * to remove the highlight. It is one component so that the two look and
 * behave as one thing: choose a colour, optionally write a note.
 */

export interface PopupAnchor {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface AnnotationPopupProps {
  readonly anchor: PopupAnchor;
  /** The highlight being edited, or `null` for a fresh selection. */
  readonly highlight: Highlight | null;
  /** Whether the note field is open. */
  readonly noteOpen: boolean;
  readonly onColour: (colour: HighlightColour) => void;
  readonly onOpenNote: () => void;
  readonly onNoteChange: (note: string) => void;
  readonly onRemove: () => void;
  readonly onListen?: () => void;
  readonly onCopy: () => void;
  readonly onClose: () => void;
}

const POPUP_WIDTH = 288;
const MARGIN = 8;

/*
 * Written out, one class to a colour, so the stylesheet tests can see
 * that every swatch has a rule.
 */
const SWATCH_CLASS: Readonly<Record<HighlightColour, string>> = {
  yellow: 'annotation-popup__swatch annotation-popup__swatch--yellow',
  green: 'annotation-popup__swatch annotation-popup__swatch--green',
  blue: 'annotation-popup__swatch annotation-popup__swatch--blue',
  pink: 'annotation-popup__swatch annotation-popup__swatch--pink',
};

const COLOUR_NAMES: Readonly<Record<HighlightColour, string>> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
};

/** Below the words when there is room, above them when there is not. */
export const placeAnnotationPopup = (
  anchor: PopupAnchor,
  viewport: { readonly width: number; readonly height: number },
  popupHeight: number,
): { readonly left: number; readonly top: number } => {
  const centred = anchor.left + anchor.width / 2 - POPUP_WIDTH / 2;
  const left = Math.max(MARGIN, Math.min(centred, viewport.width - POPUP_WIDTH - MARGIN));
  const below = anchor.top + anchor.height + MARGIN;
  const top =
    below + popupHeight <= viewport.height - MARGIN
      ? below
      : Math.max(MARGIN, anchor.top - popupHeight - MARGIN);

  return { left, top };
};

export const AnnotationPopup = ({
  anchor,
  highlight,
  noteOpen,
  onColour,
  onOpenNote,
  onNoteChange,
  onRemove,
  onListen,
  onCopy,
  onClose,
}: AnnotationPopupProps): ReactElement => {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const place = placeAnnotationPopup(
    anchor,
    { width: window.innerWidth, height: window.innerHeight },
    noteOpen ? 220 : 52,
  );

  // The note field takes the cursor when it opens, so typing goes into it.
  useEffect(() => {
    if (noteOpen) {
      noteRef.current?.focus();
    }
  }, [noteOpen]);

  return (
    <div
      className="annotation-popup"
      role="dialog"
      aria-label={highlight === null ? 'Selected text' : 'Highlight'}
      data-testid="annotation-popup"
      style={{ left: `${String(place.left)}px`, top: `${String(place.top)}px` }}
      onKeyDown={(event): void => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="annotation-popup__row">
        <div className="annotation-popup__swatches" role="group" aria-label="Highlight colour">
          {HIGHLIGHT_COLOURS.map((colour) => (
            <button
              key={colour}
              type="button"
              className={SWATCH_CLASS[colour]}
              aria-label={`Highlight ${COLOUR_NAMES[colour].toLowerCase()}`}
              title={`Highlight ${COLOUR_NAMES[colour].toLowerCase()}`}
              aria-pressed={highlight?.colour === colour}
              data-testid={`highlight-${colour}`}
              onClick={(): void => {
                onColour(colour);
              }}
            />
          ))}
        </div>

        <button
          type="button"
          className="control control--quiet annotation-popup__action"
          aria-pressed={noteOpen}
          data-testid="highlight-note"
          onClick={onOpenNote}
        >
          Note
        </button>

        {onListen !== undefined && (
          <button
            type="button"
            className="control control--quiet annotation-popup__action"
            aria-label="Read aloud"
            title="Read aloud"
            data-testid="highlight-listen"
            onClick={onListen}
          >
            <Icon name="speaker" />
          </button>
        )}

        <button
          type="button"
          className="control control--quiet annotation-popup__action"
          aria-label="Copy"
          title="Copy"
          data-testid="highlight-copy"
          onClick={onCopy}
        >
          <Icon name="copy" />
        </button>

        {highlight !== null && (
          <button
            type="button"
            className="control control--quiet annotation-popup__action"
            aria-label="Remove highlight"
            title="Remove highlight"
            data-testid="highlight-remove"
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>

      {noteOpen && highlight !== null && (
        <label className="annotation-popup__note">
          <span className="visually-hidden">Note</span>
          <textarea
            ref={noteRef}
            className="control control--field annotation-popup__note-field"
            rows={5}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Write a note…"
            value={highlight.note}
            data-testid="highlight-note-field"
            onChange={(event): void => {
              onNoteChange(event.target.value);
            }}
          />
        </label>
      )}

      {noteOpen && highlight !== null && (
        <div className="annotation-popup__foot">
          <span className="annotation-popup__saved">Saved as you type</span>
          <button type="button" className="control" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </div>
  );
};
