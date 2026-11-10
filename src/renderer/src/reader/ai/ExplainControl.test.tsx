/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExplanationIpcView } from '@shared/ipc/aiContracts';

import { ExplainControl } from './ExplainControl';
import type { ExplainControl as ExplainControlState } from './useExplainInContext';

/**
 * What the reader sees, and what they are told before anything is sent.
 */

const explanation: ExplanationIpcView = {
  text: 'Here it means stored electricity.',
  senseIndex: 0,
  truncated: false,
  createdAt: '2026-02-01T10:00:00.000Z',
  provider: 'api.example.com',
  model: 'model-a',
  remote: true,
  status: 'current',
};

const control = (overrides: Partial<ExplainControlState> = {}): ExplainControlState => ({
  state: 'idle',
  explanation: null,
  message: null,
  destination: { configured: true, provider: 'api.example.com', model: 'model-a', remote: true },
  onExplain: (): void => {},
  onCancel: (): void => {},
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe('when nothing is configured', () => {
  it('renders no control and no disclosure', () => {
    const { container } = render(
      <ExplainControl explain={control({ state: 'unsupported', destination: null })} />,
    );

    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('explanation-disclosure')).toBeNull();
  });
});

describe('before anything is sent', () => {
  it('says where this sentence would go', () => {
    render(<ExplainControl explain={control()} />);

    expect(screen.getByTestId('explanation-disclosure').textContent).toBe(
      'Sends this sentence and this word to api.example.com.',
    );
    expect(screen.getByTestId('explain-in-context').textContent).toBe('Explain in context');
  });

  it('names the local destination and says it stays on this computer', () => {
    render(
      <ExplainControl
        explain={control({
          destination: {
            configured: true,
            provider: 'localhost:11434',
            model: 'local-model',
            remote: false,
          },
        })}
      />,
    );

    // The label is the configured host, so the sentence cannot read
    // "to this device on this computer".
    expect(screen.getByTestId('explanation-disclosure').textContent).toBe(
      'Sends this sentence and this word to localhost:11434, which runs on this computer.',
    );
  });

  it('reports the press', () => {
    const onExplain = vi.fn();

    render(<ExplainControl explain={control({ onExplain })} />);
    fireEvent.click(screen.getByTestId('explain-in-context'));

    expect(onExplain).toHaveBeenCalledTimes(1);
  });
});

describe('while it is working', () => {
  it('shows nothing extra before the delay has passed', () => {
    render(<ExplainControl explain={control({ state: 'pending' })} />);

    expect(screen.queryByTestId('explanation-loading')).toBeNull();
    expect(screen.getByTestId('explanation-cancel')).toBeTruthy();
  });

  it('admits to being slow, and can be stopped', () => {
    const onCancel = vi.fn();

    render(<ExplainControl explain={control({ state: 'loading', onCancel })} />);

    expect(screen.getByTestId('explanation-loading').textContent).toBe('Generating…');

    fireEvent.click(screen.getByTestId('explanation-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('an explanation', () => {
  it('is shown as plain text under a hedged heading', () => {
    render(<ExplainControl explain={control({ state: 'ready', explanation })} />);

    expect(screen.getByText('Most likely sense here')).toBeTruthy();
    expect(screen.getByTestId('explanation-text').textContent).toBe(
      'Here it means stored electricity.',
    );
  });

  it('never interprets model output as markup', () => {
    render(
      <ExplainControl
        explain={control({
          state: 'ready',
          explanation: {
            ...explanation,
            text: 'Press <img src=x onerror="alert(1)"> and <b>bold</b> **stars**.',
          },
        })}
      />,
    );

    const paragraph = screen.getByTestId('explanation-text');

    expect(paragraph.querySelector('img')).toBeNull();
    expect(paragraph.querySelector('b')).toBeNull();
    expect(paragraph.textContent).toContain('<b>bold</b>');
  });

  it('says when it was cut short', () => {
    render(
      <ExplainControl
        explain={control({ state: 'ready', explanation: { ...explanation, truncated: true } })}
      />,
    );

    expect(screen.getByTestId('explanation-truncated')).toBeTruthy();
  });

  it('labels one written for an earlier version of the passage, and offers to redo it', () => {
    render(
      <ExplainControl
        explain={control({
          state: 'stale',
          explanation: { ...explanation, status: 'previous-context' },
        })}
      />,
    );

    expect(screen.getByTestId('explanation-previous')).toBeTruthy();
    expect(screen.getByTestId('explain-in-context').textContent).toBe('Retry');
  });

  it('keeps the dictionary primary in what it says about itself', () => {
    render(<ExplainControl explain={control({ state: 'ready', explanation })} />);

    expect(screen.getByText(/It may be wrong; the definition above is not\./u)).toBeTruthy();
  });

  it('still discloses the destination, because pressing again sends again', () => {
    render(<ExplainControl explain={control({ state: 'ready', explanation })} />);

    expect(screen.getByTestId('explanation-disclosure')).toBeTruthy();
  });
});

describe('a failure', () => {
  it('shows one sentence and a way to try again', () => {
    render(
      <ExplainControl
        explain={control({
          state: 'failed',
          message: 'Context explanation is currently unavailable.',
        })}
      />,
    );

    expect(screen.getByTestId('explanation-error').textContent).toBe(
      'Context explanation is currently unavailable.',
    );
    expect(screen.getByTestId('explain-in-context').textContent).toBe('Retry');
  });

  it('is announced to assistive technology without stealing focus', () => {
    render(
      <ExplainControl
        explain={control({
          state: 'failed',
          message: 'Context explanation is currently unavailable.',
        })}
      />,
    );

    expect(screen.getByTestId('explanation-error').getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(document.body);
  });
});
