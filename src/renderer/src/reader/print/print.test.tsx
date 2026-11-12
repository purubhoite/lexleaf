/** @vitest-environment jsdom */
import type { OpenedPdf } from '@core/pdf/pdfEngine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrintDialog } from './PrintDialog';
import { pagesInRange, type PrintRequest } from './printDocument';

afterEach(() => {
  cleanup();
});

const book = {} as OpenedPdf;

const show = (print: (request: PrintRequest) => Promise<'printed' | 'cancelled' | 'failed'>) => {
  const onClose = vi.fn();

  render(
    <PrintDialog
      document={book}
      documentName="essay.pdf"
      pageCount={12}
      currentPage={4}
      rotation={90}
      onClose={onClose}
      print={print}
    />,
  );

  return onClose;
};

describe('the pages a range names', () => {
  it('lists them in order', () => {
    expect(pagesInRange(3, 5, 10)).toStrictEqual([3, 4, 5]);
  });

  it('accepts the ends either way round', () => {
    expect(pagesInRange(5, 3, 10)).toStrictEqual([3, 4, 5]);
  });

  it('stays inside the book', () => {
    expect(pagesInRange(0, 99, 4)).toStrictEqual([1, 2, 3, 4]);
    expect(pagesInRange(8, 9, 4)).toStrictEqual([]);
  });

  it('names nothing for something that is not a number', () => {
    expect(pagesInRange(Number.NaN, 3, 10)).toStrictEqual([]);
  });
});

describe('the print dialog', () => {
  it('prints the whole book by default, turned as the reader turned it', async () => {
    const print = vi.fn<(request: PrintRequest) => Promise<'printed'>>(() =>
      Promise.resolve('printed'),
    );
    const onClose = show(print);

    fireEvent.click(screen.getByTestId('print-go'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });

    const request = print.mock.calls[0]?.[0];

    expect(request?.pages).toHaveLength(12);
    expect(request?.rotation).toBe(90);
  });

  it('prints only the page being read when asked', () => {
    const print = vi.fn<(request: PrintRequest) => Promise<'printed'>>(
      () => new Promise(() => undefined),
    );
    show(print);

    fireEvent.click(screen.getByLabelText('This page (4)'));
    fireEvent.click(screen.getByTestId('print-go'));

    expect(print.mock.calls[0]?.[0].pages).toStrictEqual([4]);
  });

  it('prints a range, and will not start on one that names no page', () => {
    const print = vi.fn<(request: PrintRequest) => Promise<'printed'>>(
      () => new Promise(() => undefined),
    );
    show(print);

    fireEvent.focus(screen.getByTestId('print-from'));
    fireEvent.change(screen.getByTestId('print-from'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('print-to'), { target: { value: '50' } });

    expect(screen.getByTestId<HTMLButtonElement>('print-go').disabled).toBe(true);

    fireEvent.change(screen.getByTestId('print-from'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('print-to'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('print-go'));

    expect(print.mock.calls[0]?.[0].pages).toStrictEqual([2, 3]);
  });

  it('says how far it has got, and stops when told to', () => {
    let request: PrintRequest | undefined;
    const onClose = show((given) => {
      request = given;
      given.onProgress(2, 12);

      return new Promise(() => undefined);
    });

    fireEvent.click(screen.getByTestId('print-go'));

    expect(screen.getByTestId('print-progress').textContent).toContain('page 3 of 12');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    cleanup();

    expect(onClose).toHaveBeenCalledOnce();
    expect(request?.signal.aborted).toBe(true);
  });

  it('stays open and says so when the pages could not be prepared', async () => {
    const onClose = show(() => Promise.resolve('failed'));

    fireEvent.click(screen.getByTestId('print-go'));

    expect(await screen.findByText(/could not be prepared/u)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });
});
