import { useState, type ReactElement } from 'react';

import type { LicenceDocumentId, LicenceReadResult } from '@shared/ipc/contracts';

import { Message } from '../ui/Message';

/**
 * "Licences", in the settings screen.
 *
 * Two documents, chosen by a button each: the Apache-2.0 licence and the
 * notices that ship with the application, and the third-party notices for
 * the dictionary data. Both are in the installed application — the reader
 * does not have to visit GitHub to read the terms they received the
 * software under.
 *
 * The text is shown as preformatted text rather than parsed into markup:
 * a licence's wording is the licence, and nothing here should be able to
 * change what it says.
 */

export interface LicencesProps {
  /**
   * Reads a document. Resolves a typed result: a build without its notices
   * is a normal answer, not an exception.
   */
  readonly onRead: (id: LicenceDocumentId) => Promise<LicenceReadResult>;
}

type Loaded =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly title: string; readonly text: string }
  | { readonly status: 'failed'; readonly message: string };

const FAILURE_TEXT: Record<'not-installed' | 'unreadable', string> = {
  'not-installed': 'These notices were not included in this build.',
  unreadable: 'These notices could not be read.',
};

const DOCUMENTS: readonly { readonly id: LicenceDocumentId; readonly label: string }[] = [
  { id: 'application', label: 'Lexleaf licence and notices' },
  { id: 'dictionary', label: 'Dictionary notices' },
];

export const Licences = ({ onRead }: LicencesProps): ReactElement => {
  const [shown, setShown] = useState<LicenceDocumentId | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' });

  const show = (id: LicenceDocumentId): void => {
    // A second press closes it: the panel is a glance, not a destination.
    if (shown === id) {
      setShown(null);
      setLoaded({ status: 'idle' });

      return;
    }

    setShown(id);
    setLoaded({ status: 'loading' });

    void onRead(id).then(
      (result) => {
        if (result.ok) {
          setLoaded({ status: 'ready', title: result.value.title, text: result.value.text });
        } else {
          setLoaded({ status: 'failed', message: FAILURE_TEXT[result.reason] });
        }
      },
      () => {
        setLoaded({ status: 'failed', message: FAILURE_TEXT.unreadable });
      },
    );
  };

  return (
    <fieldset className="settings__group" data-testid="setting-licences">
      <legend className="settings__legend">Licences</legend>
      <p className="settings__note">
        Lexleaf&rsquo;s own code is under the Apache License 2.0. The dictionary that ships with it
        is third-party data with its own terms, which are shown here in full.
      </p>

      <div className="licences__buttons">
        {DOCUMENTS.map((document) => (
          <button
            key={document.id}
            type="button"
            className="control"
            aria-expanded={shown === document.id}
            data-testid={`licence-${document.id}`}
            onClick={(): void => {
              show(document.id);
            }}
          >
            {document.label}
          </button>
        ))}
      </div>

      {loaded.status === 'loading' && <Message kind="busy">Reading…</Message>}

      {loaded.status === 'failed' && (
        <Message kind="problem" testId="licence-failed">
          {loaded.message}
        </Message>
      )}

      {loaded.status === 'ready' && (
        <div className="licences__document" data-testid="licence-text">
          <h4 className="licences__title">{loaded.title}</h4>
          <pre className="licences__text">{loaded.text}</pre>
        </div>
      )}
    </fieldset>
  );
};
