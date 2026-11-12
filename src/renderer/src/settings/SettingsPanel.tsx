import type { ReactElement, ReactNode } from 'react';

import type { PreferenceKey, Preferences } from '@core/persistence/preferences';

/**
 * The settings surface (ADR-031).
 *
 * Four preferences, four groups of radio buttons, and nothing else. What
 * it does *not* contain is as much of the design as what it does: there is
 * no field for a provider endpoint, a model, an API key, a host, a port, a
 * folder or a file, and no free-text input of any kind. Every control here
 * is a radio button over a closed set of values, so the surface is
 * incapable of carrying a secret, a URL or a path — a property a test can
 * check by reading this file, rather than a rule a reviewer has to
 * remember (ADR-031's structural test).
 *
 * Shape and behaviour:
 *
 * - a panel in the existing shell, shown the way the library is shown: the
 *   reading surface is hidden, not unmounted, so the open document, every
 *   rendered page and the reader's place in it survive a trip to settings;
 * - no second window, no modal, no focus trap. The reader can tab out of
 *   it the same way they tab out of anything else, and \"Back to reading\"
 *   is a button, not a dismissal gesture;
 * - native radio groups in native fieldsets. The group's accessible name
 *   is its `<legend>`, arrow keys move within a group and Tab moves
 *   between groups, because that is what the platform control does
 *   (A11Y-14: no `role` the element does not need, no re-implemented
 *   keyboard handling);
 * - each change takes effect at once. There is no Apply button and no
 *   Cancel: every preference here is reversible by choosing the other
 *   value, so a confirmation step would add ceremony without adding
 *   safety.
 */

export interface SettingsPanelProps {
  readonly preferences: Preferences;
  readonly onChange: <K extends PreferenceKey>(key: K, value: Preferences[K]) => void;
  readonly onClose: () => void;
  /**
   * Groups owned by another part of the application, shown after the
   * preferences. The panel lays them out and knows nothing else about them.
   */
  readonly children?: ReactNode;
}

interface Choice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** One line under the label, explaining what the value does. */
  readonly description: string;
}

const APPEARANCE_CHOICES: readonly Choice<Preferences['appearance']>[] = [
  {
    value: 'system',
    label: 'Match the system',
    description: 'Follows the light or dark setting of this computer, as it changes.',
  },
  { value: 'light', label: 'Light', description: 'Always light, whatever the system is set to.' },
  { value: 'dark', label: 'Dark', description: 'Always dark, whatever the system is set to.' },
];

const REDUCE_MOTION_CHOICES: readonly Choice<Preferences['reduceMotion']>[] = [
  {
    value: 'system',
    label: 'Match the system',
    description: 'Uses this computer’s reduced-motion setting.',
  },
  {
    value: 'always',
    label: 'Always reduce motion',
    description: 'Turns off every animation and transition in the application.',
  },
];

const DEFAULT_ZOOM_CHOICES: readonly Choice<Preferences['defaultZoomMode']>[] = [
  { value: 'fit-width', label: 'Fit width', description: 'Fills the window with the page width.' },
  { value: 'fit-page', label: 'Fit page', description: 'Shows a whole page at a time.' },
  {
    value: 'last-used',
    label: 'The zoom I used last',
    description: 'Opens at the zoom of the last document you read.',
  },
];

const DIAGNOSTICS_CHOICES: readonly Choice<Preferences['showDeveloperDiagnostics']>[] = [
  { value: 'off', label: 'Keep it closed', description: 'The usual view: the document and words.' },
  {
    value: 'on',
    label: 'Open it by default',
    description: 'Expands the existing developer diagnostics panel as you read.',
  },
];

interface ChoiceGroupProps<Key extends PreferenceKey> {
  readonly name: Key;
  readonly legend: string;
  readonly note: string;
  readonly testId: string;
  readonly choices: readonly Choice<Preferences[Key] & string>[];
  readonly selected: Preferences[Key];
  readonly onChange: (key: Key, value: Preferences[Key]) => void;
}

const ChoiceGroup = <Key extends PreferenceKey>({
  name,
  legend,
  note,
  testId,
  choices,
  selected,
  onChange,
}: ChoiceGroupProps<Key>): ReactElement => (
  <fieldset className="settings__group" data-testid={testId}>
    <legend className="settings__legend">{legend}</legend>
    <p className="settings__note">{note}</p>

    {choices.map((choice) => (
      /*
       * The label wraps the input, so the whole row — text included — is
       * the hit target and the accessible name needs no `for`/`id` pair
       * to stay correct. This is the `.checkbox` pattern the diagnostics
       * panel already uses, with `accent-color` doing the theming: the
       * native control is kept, never redrawn with `appearance: none`.
       */
      <label className="settings__choice" key={choice.value}>
        <input
          type="radio"
          className="settings__radio"
          name={name}
          value={choice.value}
          checked={selected === choice.value}
          onChange={(): void => {
            onChange(name, choice.value);
          }}
        />
        <span className="settings__choice-text">
          <span className="settings__choice-label">{choice.label}</span>
          <span className="settings__choice-description">{choice.description}</span>
        </span>
      </label>
    ))}
  </fieldset>
);

export const SettingsPanel = ({
  preferences,
  onChange,
  onClose,
  children,
}: SettingsPanelProps): ReactElement => (
  <section className="settings" aria-label="Settings" data-testid="settings">
    <div className="settings__header">
      <h2 className="settings__title">Settings</h2>
      <button
        type="button"
        className="control settings__close"
        data-testid="settings-close"
        onClick={onClose}
      >
        Back to reading
      </button>
    </div>

    <p className="settings__intro">
      Changes apply straight away and are remembered for next time. Your choices are stored on this
      computer, beside the list of documents you have opened, and are not sent anywhere.
    </p>

    <ChoiceGroup
      name="appearance"
      legend="Appearance"
      note="Controls Lexleaf’s colours and contrast. PDF pages are always shown exactly as the document defines them."
      testId="setting-appearance"
      choices={APPEARANCE_CHOICES}
      selected={preferences.appearance}
      onChange={onChange}
    />

    <ChoiceGroup
      name="reduceMotion"
      legend="Motion"
      note="Controls short animations in Lexleaf. The document never moves on its own."
      testId="setting-reduce-motion"
      choices={REDUCE_MOTION_CHOICES}
      selected={preferences.reduceMotion}
      onChange={onChange}
    />

    <ChoiceGroup
      name="defaultZoomMode"
      legend="Default zoom"
      note="Used when a document is opened for the first time. A document you have read before reopens where and how you left it."
      testId="setting-default-zoom"
      choices={DEFAULT_ZOOM_CHOICES}
      selected={preferences.defaultZoomMode}
      onChange={onChange}
    />

    {!import.meta.env.PROD && (
      <ChoiceGroup
        name="showDeveloperDiagnostics"
        legend="Developer diagnostics"
        note="Whether the diagnostics panel under the document starts open. It shows the same information either way."
        testId="setting-developer-diagnostics"
        choices={DIAGNOSTICS_CHOICES}
        selected={preferences.showDeveloperDiagnostics}
        onChange={onChange}
      />
    )}

    {children}
  </section>
);
