// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LicenceReadResult } from '@shared/ipc/contracts';

import { Licences } from './Licences';

afterEach(() => {
  cleanup();
});

const readLicence = (result: LicenceReadResult) =>
  vi.fn(() => Promise.resolve<LicenceReadResult>(result));

describe('Licences', () => {
  it('shows the licence text after it is asked for', async () => {
    const onRead = readLicence({
      ok: true,
      value: {
        id: 'application',
        title: 'Lexleaf — Apache License 2.0 and notices',
        text: 'APACHE',
      },
    });

    render(<Licences onRead={onRead} />);

    // Nothing is read until the reader asks: the settings screen must not
    // read files to draw itself.
    expect(onRead).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('licence-application'));

    await waitFor(() => {
      expect(screen.getByTestId('licence-text').textContent).toContain('APACHE');
    });
    expect(onRead).toHaveBeenCalledExactlyOnceWith('application');
  });

  it('renders the text as text, not as markup a notice could smuggle in', async () => {
    const onRead = readLicence({
      ok: true,
      value: { id: 'dictionary', title: 'Dictionary data', text: '<script>alert(1)</script>' },
    });

    render(<Licences onRead={onRead} />);
    fireEvent.click(screen.getByTestId('licence-dictionary'));

    const shown = await screen.findByTestId('licence-text');

    expect(shown.querySelector('script')).toBeNull();
    expect(shown.textContent).toContain('<script>alert(1)</script>');
  });

  it('says a build carries no notices rather than showing an error', async () => {
    render(<Licences onRead={readLicence({ ok: false, reason: 'not-installed' })} />);

    fireEvent.click(screen.getByTestId('licence-dictionary'));

    const message = await screen.findByTestId('licence-failed');

    expect(message.textContent).toContain('were not included in this build');
    expect(message.getAttribute('role')).toBe('alert');
  });

  it('closes the document when its own button is pressed again', async () => {
    render(
      <Licences
        onRead={readLicence({
          ok: true,
          value: { id: 'application', title: 'Lexleaf', text: 'APACHE' },
        })}
      />,
    );

    const button = screen.getByTestId('licence-application');

    fireEvent.click(button);
    await screen.findByTestId('licence-text');

    fireEvent.click(button);

    expect(screen.queryByTestId('licence-text')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('marks the open document in its button, for a screen reader', async () => {
    render(
      <Licences
        onRead={readLicence({
          ok: true,
          value: { id: 'application', title: 'Lexleaf', text: 'APACHE' },
        })}
      />,
    );

    const button = screen.getByTestId('licence-application');

    fireEvent.click(button);
    await screen.findByTestId('licence-text');

    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
