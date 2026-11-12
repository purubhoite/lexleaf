/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportProblem } from './ReportProblem';

afterEach(() => {
  cleanup();
});

describe('reporting a problem', () => {
  it('says what the button does and that nothing is sent without the reader', () => {
    render(<ReportProblem onReport={vi.fn(() => Promise.resolve(true))} />);

    const group = screen.getByRole('group', { name: 'Report a problem' });

    expect(group.textContent).toContain('Lexleaf sends nothing by itself');
    expect(group.textContent).toContain('choose whether to submit it');
  });

  it('opens the report when pressed, passing nothing', async () => {
    const onReport = vi.fn(() => Promise.resolve(true));
    render(<ReportProblem onReport={onReport} />);

    fireEvent.click(screen.getByTestId('report-problem'));

    expect(onReport).toHaveBeenCalledExactlyOnceWith();
    await Promise.resolve();
    expect(screen.queryByTestId('report-problem-failed')).toBeNull();
  });

  it('gives the address when the browser could not be opened', async () => {
    render(<ReportProblem onReport={() => Promise.resolve(false)} />);

    fireEvent.click(screen.getByTestId('report-problem'));

    expect((await screen.findByTestId('report-problem-failed')).textContent).toContain(
      'github.com/purubhoite/lexleaf/issues',
    );
  });

  it('gives the address when the request itself fails, and clears it on a retry that works', async () => {
    const onReport = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce(true);
    render(<ReportProblem onReport={onReport} />);

    fireEvent.click(screen.getByTestId('report-problem'));
    await screen.findByTestId('report-problem-failed');

    fireEvent.click(screen.getByTestId('report-problem'));

    expect(screen.queryByTestId('report-problem-failed')).toBeNull();
  });
});
