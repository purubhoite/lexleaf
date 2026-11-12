import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import type { OpenedPdf } from '@core/pdf/pdfEngine';

import { Message } from '../../ui/Message';

import { pagesInRange, printDocument, type PrintOutcome } from './printDocument';

/**
 * The print window's first step: which pages.
 *
 * The system's own print window — printer, paper, copies — opens once the
 * pages have been prepared. Preparing takes a moment a page, so the choice
 * of pages comes first, a long job says how far it has got, and it can be
 * stopped.
 */

export interface PrintDialogProps {
  readonly document: OpenedPdf;
  readonly documentName: string;
  readonly pageCount: number;
  readonly currentPage: number;
  readonly rotation: number;
  readonly onClose: () => void;
  /** Replaceable for tests; defaults to the real thing. */
  readonly print?: typeof printDocument;
}

type Choice = 'all' | 'current' | 'range';

/** Beyond this many pages the reader is told it will take a while. */
const LONG_JOB = 150;

type Phase =
  | { readonly status: 'choosing' }
  | { readonly status: 'preparing'; readonly done: number; readonly total: number }
  | { readonly status: 'failed' };

export const PrintDialog = ({
  document: pdfDocument,
  documentName,
  pageCount,
  currentPage,
  rotation,
  onClose,
  print = printDocument,
}: PrintDialogProps): ReactElement => {
  const [choice, setChoice] = useState<Choice>('all');
  const [from, setFrom] = useState(String(currentPage));
  const [to, setTo] = useState(String(currentPage));
  const [phase, setPhase] = useState<Phase>({ status: 'choosing' });
  const abort = useRef<AbortController | null>(null);
  const firstChoice = useRef<HTMLInputElement>(null);
  const printRoot = useRef<HTMLDivElement>(null);
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    firstChoice.current?.focus();

    // Closing the dialog stops a job that is still being prepared.
    return (): void => {
      abort.current?.abort();
    };
  }, []);

  const pages =
    choice === 'all'
      ? pagesInRange(1, pageCount, pageCount)
      : choice === 'current'
        ? [currentPage]
        : pagesInRange(Number(from), Number(to), pageCount);

  const preparing = phase.status === 'preparing';

  const start = (event: FormEvent): void => {
    event.preventDefault();

    if (pages.length === 0 || preparing) {
      return;
    }

    const root = printRoot.current;

    if (root === null) {
      return;
    }

    const controller = new AbortController();

    abort.current = controller;
    setPhase({ status: 'preparing', done: 0, total: pages.length });

    void print({
      document: pdfDocument,
      pages,
      rotation,
      root,
      showForPrinting: (show) => {
        // The window's own content is hidden for the moment of printing,
        // so that the paper carries the pages and nothing else.
        for (const child of document.body.children) {
          if (child instanceof HTMLElement && child !== root) {
            child.style.display = show ? 'none' : '';
          }
        }

        root.className = show ? 'print-root print-root--printing' : 'print-root';
        setShowing(show);
      },
      signal: controller.signal,
      onProgress: (done, total) => {
        setPhase({ status: 'preparing', done, total });
      },
    }).then(
      (outcome: PrintOutcome) => {
        if (outcome === 'failed') {
          setPhase({ status: 'failed' });
        } else {
          onClose();
        }
      },
      () => {
        setPhase({ status: 'failed' });
      },
    );
  };

  return (
    <div className="print-dialog__backdrop" data-testid="print-dialog">
      {createPortal(
        <div
          ref={printRoot}
          className={showing ? 'print-root print-root--printing' : 'print-root'}
          data-page-class="print-root__page"
          aria-hidden="true"
        />,
        document.body,
      )}
      <form
        className="print-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Print"
        onSubmit={start}
        onKeyDown={(event): void => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="print-dialog__title">Print</h2>
        <p className="print-dialog__name" title={documentName}>
          {documentName}
        </p>

        <fieldset className="print-dialog__choices" disabled={preparing}>
          <legend className="visually-hidden">Pages to print</legend>
          <label className="print-dialog__choice">
            <input
              ref={firstChoice}
              type="radio"
              name="print-pages"
              checked={choice === 'all'}
              onChange={(): void => {
                setChoice('all');
              }}
            />
            All {String(pageCount)} pages
          </label>
          <label className="print-dialog__choice">
            <input
              type="radio"
              name="print-pages"
              checked={choice === 'current'}
              onChange={(): void => {
                setChoice('current');
              }}
            />
            This page ({String(currentPage)})
          </label>
          <div className="print-dialog__choice">
            <label className="print-dialog__choice">
              <input
                type="radio"
                name="print-pages"
                checked={choice === 'range'}
                onChange={(): void => {
                  setChoice('range');
                }}
              />
              Pages
            </label>
            <input
              className="control control--field print-dialog__number"
              type="number"
              min={1}
              max={pageCount}
              aria-label="From page"
              value={from}
              data-testid="print-from"
              onFocus={(): void => {
                setChoice('range');
              }}
              onChange={(event): void => {
                setFrom(event.target.value);
              }}
            />
            <span aria-hidden="true">to</span>
            <input
              className="control control--field print-dialog__number"
              type="number"
              min={1}
              max={pageCount}
              aria-label="To page"
              value={to}
              data-testid="print-to"
              onFocus={(): void => {
                setChoice('range');
              }}
              onChange={(event): void => {
                setTo(event.target.value);
              }}
            />
          </div>
        </fieldset>

        {phase.status === 'choosing' && pages.length > LONG_JOB && (
          <Message kind="info" announce={false}>
            Preparing {String(pages.length)} pages for the printer takes a minute or two.
          </Message>
        )}

        {phase.status === 'choosing' && choice === 'range' && pages.length === 0 && (
          <Message kind="info" announce={false}>
            Enter page numbers between 1 and {String(pageCount)}.
          </Message>
        )}

        {phase.status === 'preparing' && (
          <div className="print-dialog__progress" data-testid="print-progress">
            <Message kind="busy">
              Preparing page {String(Math.min(phase.done + 1, phase.total))} of{' '}
              {String(phase.total)}…
            </Message>
            <progress
              className="print-dialog__bar"
              max={phase.total}
              value={phase.done}
              aria-label="Pages prepared"
            />
          </div>
        )}

        {phase.status === 'failed' && (
          <Message kind="problem">
            The pages could not be prepared for printing. Try again, or print fewer pages at a time.
          </Message>
        )}

        <div className="print-dialog__actions">
          <button type="button" className="control" onClick={onClose}>
            {preparing ? 'Stop' : 'Cancel'}
          </button>
          <button
            type="submit"
            className="control print-dialog__go"
            disabled={preparing || pages.length === 0}
            data-testid="print-go"
          >
            Print…
          </button>
        </div>
      </form>
    </div>
  );
};
