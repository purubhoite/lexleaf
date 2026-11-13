/** @vitest-environment jsdom */
import { DEFAULT_PREFERENCES, type Preferences } from '@core/persistence/preferences';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from './SettingsPanel';

/**
 * The settings surface (ADR-031).
 *
 * What the rendered panel does: four groups, the stored value shown as
 * the chosen one, a change reported once with the right field and value,
 * and native controls throughout.
 *
 * ADR-031's privacy claim is about *absence*, which rendering cannot show
 * — a password field that no test renders still ships. That claim is made
 * against this component's source in
 * `tests/unit/chrome/settingsSurface.test.ts`, which is allowed to read
 * files; renderer tests are not.
 */

const panel = (preferences: Partial<Preferences> = {}): ReturnType<typeof vi.fn> => {
  const onChange = vi.fn();

  render(
    <SettingsPanel
      preferences={{ ...DEFAULT_PREFERENCES, ...preferences }}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );

  return onChange;
};

afterEach(cleanup);

describe('the settings panel', () => {
  it('is a labelled region, not a dialog', () => {
    panel();

    const region = screen.getByTestId('settings');

    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('aria-label')).toBe('Settings');
    // No modal, no focus trap, no second window (ADR-031).
    expect(region.getAttribute('role')).toBeNull();
    expect(region.getAttribute('aria-modal')).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('shows exactly the preferences there are', () => {
    panel();

    const groups = screen.getAllByRole('group');

    expect(groups.map((group) => group.getAttribute('data-testid'))).toStrictEqual([
      'setting-appearance',
      'setting-reduce-motion',
      'setting-default-zoom',
      'setting-page-tint',
    ]);
    expect(groups.map((group) => group.querySelector('legend')?.textContent)).toStrictEqual([
      'Appearance',
      'Motion',
      'Default zoom',
      'Page colour',
    ]);
  });

  it('offers every value of every preference as a radio button', () => {
    panel();

    expect(screen.getAllByRole('radio')).toHaveLength(12);

    for (const [testId, labels] of [
      ['setting-appearance', ['Match the system', 'Light', 'Dark']],
      ['setting-reduce-motion', ['Match the system', 'Always reduce motion']],
      ['setting-default-zoom', ['Fit width', 'Fit page', 'The zoom I used last']],
      ['setting-page-tint', ['Original', 'Sepia', 'Dimmed', 'Night']],
    ] as const) {
      const group = screen.getByTestId(testId);

      expect(within(group).getAllByRole('radio')).toHaveLength(labels.length);

      for (const label of labels) {
        expect(within(group).getByText(label)).toBeTruthy();
      }
    }
  });

  it('shows the stored value as the chosen one', () => {
    panel({
      appearance: 'dark',
      reduceMotion: 'always',
      defaultZoomMode: 'last-used',
      showDeveloperDiagnostics: 'on',
    });

    const checked = screen
      .getAllByRole('radio')
      .filter((radio): radio is HTMLInputElement => (radio as HTMLInputElement).checked);

    expect(checked.map((radio) => radio.value)).toStrictEqual([
      'dark',
      'always',
      'last-used',
      'original',
    ]);
  });

  it('reports one field and one value when a choice is made', () => {
    const onChange = panel();

    fireEvent.click(screen.getByRole('radio', { name: /Dark/u }));
    fireEvent.click(screen.getByRole('radio', { name: /Always reduce motion/u }));
    fireEvent.click(screen.getByRole('radio', { name: /Fit page/u }));

    expect(onChange.mock.calls).toStrictEqual([
      ['appearance', 'dark'],
      ['reduceMotion', 'always'],
      ['defaultZoomMode', 'fit-page'],
    ]);
  });

  it('does not report a change when the chosen value is re-chosen', () => {
    const onChange = panel({ appearance: 'dark' });

    fireEvent.click(screen.getByRole('radio', { name: /Dark/u }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on request', () => {
    const onClose = vi.fn();

    render(
      <SettingsPanel preferences={DEFAULT_PREFERENCES} onChange={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId('settings-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the settings panel’s accessible structure', () => {
  it('names every radio and every group without an aria-label', () => {
    panel();

    for (const radio of screen.getAllByRole('radio')) {
      // The name comes from the label the input sits inside, which is
      // also the visible text: nothing here says one thing on screen and
      // another to assistive technology (WCAG 2.5.3).
      const label = radio.closest('label');

      expect(label).not.toBeNull();
      expect((label?.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(radio.getAttribute('aria-label')).toBeNull();
      expect(radio.getAttribute('aria-labelledby')).toBeNull();
    }

    for (const group of screen.getAllByRole('group')) {
      const legend = group.querySelector('legend');

      expect(group.tagName).toBe('FIELDSET');
      expect((legend?.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(group.getAttribute('aria-label')).toBeNull();
    }
  });

  it('groups the radios by name, so arrow keys move within one preference', () => {
    panel();

    const names = new Set(
      screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).name),
    );

    expect([...names].sort()).toStrictEqual([
      'appearance',
      'defaultZoomMode',
      'pageTint',
      'reduceMotion',
    ]);
  });

  it('keeps every control in the tab order and adds no tabindex of its own', () => {
    panel();

    for (const element of [...screen.getAllByRole('radio'), screen.getByTestId('settings-close')]) {
      expect(element.getAttribute('tabindex')).toBeNull();
      expect(element.hasAttribute('disabled')).toBe(false);
    }
  });

  it('uses native controls rather than redrawn ones', () => {
    panel();

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.tagName).toBe('INPUT');
      expect((radio as HTMLInputElement).type).toBe('radio');
    }

    expect(screen.getByTestId('settings-close').tagName).toBe('BUTTON');
    expect(document.querySelectorAll('div[role]')).toHaveLength(0);
  });

  it('puts each radio inside its label, so the whole row is the target', () => {
    panel();

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.closest('label')).not.toBeNull();
    }
  });
});

describe('what the settings panel cannot contain (ADR-031)', () => {
  /*
   * The claims about what is *absent* from this component's source are
   * made in tests/unit/chrome/settingsSurface.test.ts, which may read
   * files; the renderer's own tests may not. What can be proved here is
   * what the rendered panel offers.
   */

  it('renders no input the four preferences do not need', () => {
    panel();

    const inputs = [...document.querySelectorAll('input')];

    expect(inputs).toHaveLength(12);
    expect(inputs.every((input) => input.type === 'radio')).toBe(true);
    expect(document.querySelectorAll('textarea, select, input[type="file"]')).toHaveLength(0);
  });

  it('asks the reader to type nothing at all', () => {
    panel();

    expect(document.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(document.querySelector('form')).toBeNull();
  });
});
