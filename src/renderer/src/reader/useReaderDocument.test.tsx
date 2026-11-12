/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenedPdf, PdfEngine, PdfSource } from '@core/pdf/pdfEngine';
import type { PdfOpenFailure } from '@core/pdf/types';
import type { Result } from '@core/result';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, DocumentPayload, DocumentRequestResult } from '@shared/ipc/contracts';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * Document lifecycle: open, close, reopen, switch, cancel, and the late
 * arrival of a document the reader has already moved on from.
 *
 * The engine is replaced with a controllable fake so that "still loading" is
 * a state the test can hold open; everything else — the hook, its request
 * numbering and its cancellation — is real.
 */

interface PendingOpen {
  readonly source: PdfSource;
  resolve(result: Result<OpenedPdf, PdfOpenFailure>): void;
}

const pendingOpens: PendingOpen[] = [];
const closed: string[] = [];
/** Lets a test play an engine that finishes a load it was asked to abandon. */
const behaviour = { honourAbort: true };

const fakeDocument = (label: string, pageCount = 3): OpenedPdf => ({
  pageCount,
  label,
  getPageText: (pageNumber: number) =>
    Promise.resolve({ pageNumber, segments: [], hasTextLayer: true }),
  getPageSize: () => Promise.resolve({ width: 600, height: 800, rotation: 0 }),
  getOutline: () => Promise.resolve([]),
  getNativePage: () => Promise.resolve({}),
  close: (): Promise<void> => {
    closed.push(label);

    return Promise.resolve();
  },
});

vi.mock('./pdf/rendererEngine', () => ({
  createRendererPdfEngine: (): PdfEngine => ({
    name: 'fake',
    version: '0',
    open: (source: PdfSource): Promise<Result<OpenedPdf, PdfOpenFailure>> =>
      new Promise((resolve) => {
        const entry: PendingOpen = { source, resolve };

        pendingOpens.push(entry);

        source.signal?.addEventListener('abort', () => {
          if (!behaviour.honourAbort) {
            return;
          }

          resolve({
            ok: false,
            error: { kind: 'cancelled', message: 'Opening was cancelled.', cause: 'AbortError' },
          });
        });
      }),
  }),
}));

const { useReaderDocument } = await import('./useReaderDocument');

const payload = (id: string, name: string): DocumentPayload => ({
  id,
  name,
  sizeBytes: 10,
  bytes: new Uint8Array([1, 2, 3]),
  position: null,
});

interface FakeBridge extends DesktopBridge {
  dialogResult: DocumentRequestResult;
  recentResult: DocumentRequestResult;
}

const createBridge = (overrides: Partial<DesktopBridge> = {}): FakeBridge => {
  const bridge: FakeBridge = {
    dialogResult: { status: 'none' },
    recentResult: { status: 'none' },
    getAppInfo: () =>
      Promise.resolve({ name: 'test', version: '0', electronVersion: '0', chromeVersion: '0' }),
    openDocumentDialog: () => Promise.resolve(bridge.dialogResult),
    getInitialDocument: () => Promise.resolve<DocumentRequestResult>({ status: 'none' }),
    openRecentDocument: () => Promise.resolve(bridge.recentResult),
    getReaderState: () => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT),
    saveReadingPosition: () => Promise.resolve('ok' as const),
    forgetDocument: () => Promise.resolve('ok' as const),
    savePreferences: () => Promise.resolve('ok' as const),
    lookUpWord: () =>
      Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
    vocabulary: unavailableVocabularyBridge(),
    ai: unconfiguredAiBridge(),
    ...overrides,
  };

  return bridge;
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  pendingOpens.length = 0;
  closed.length = 0;
  behaviour.honourAbort = true;
});

describe('useReaderDocument', () => {
  it('starts with nothing open', () => {
    const { result } = renderHook(() => useReaderDocument(createBridge()));

    expect(result.current.state.status).toBe('empty');
  });

  it('shows a loading state with the document name while it opens', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'harbour.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({ status: 'loading', name: 'harbour.pdf' });
  });

  it('reports progress while a document loads', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'harbour.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });

    act(() => {
      pendingOpens[0]?.source.onProgress?.({ loaded: 50, total: 100 });
    });

    expect(result.current.state).toMatchObject({
      status: 'loading',
      progress: { loaded: 50, total: 100 },
    });
  });

  it('becomes ready, carrying the document identity and restored position', async () => {
    const bridge = createBridge();

    bridge.dialogResult = {
      status: 'opened',
      document: {
        ...payload('id-a', 'harbour.pdf'),
        position: { page: 4, pageOffsetFraction: 0.5, zoom: { mode: 'fixed', scale: 1.25 } },
      },
    };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });

    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('harbour.pdf') });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({
      status: 'ready',
      documentId: 'id-a',
      name: 'harbour.pdf',
      pageCount: 3,
      restored: { page: 4 },
    });
  });

  it('marks each open with a new token, so reopening the same document restores it again', async () => {
    // Closing a document and picking it out of the recent list gives the same
    // document id both times; the reader keys "restore the saved position"
    // off the open, not off the id, or the second visit would start at the
    // top of the document.
    const bridge = createBridge();
    const document: DocumentPayload = {
      ...payload('id-a', 'harbour.pdf'),
      position: { page: 4, pageOffsetFraction: 0.5, zoom: { mode: 'fixed', scale: 1.25 } },
    };

    bridge.dialogResult = { status: 'opened', document };
    bridge.recentResult = { status: 'opened', document };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('harbour.pdf') });
      await Promise.resolve();
    });

    const first = result.current.state;

    expect(first.status).toBe('ready');

    await act(async () => {
      await result.current.close();
    });
    await act(async () => {
      void result.current.openRecent('id-a');
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[1]?.resolve({ ok: true, value: fakeDocument('harbour.pdf') });
      await Promise.resolve();
    });

    const second = result.current.state;

    expect(second).toMatchObject({ status: 'ready', documentId: 'id-a', restored: { page: 4 } });
    expect(first.status === 'ready' && second.status === 'ready').toBe(true);

    if (first.status === 'ready' && second.status === 'ready') {
      expect(second.openToken).toBeGreaterThan(first.openToken);
    }
  });

  it('closes the document and returns to the start screen', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'harbour.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('harbour.pdf') });
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.close();
    });

    expect(result.current.state.status).toBe('empty');
    expect(closed).toEqual(['harbour.pdf']);
  });

  it('closes the previous document when another one is opened', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'a.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('a.pdf') });
      await Promise.resolve();
    });

    bridge.dialogResult = { status: 'opened', document: payload('id-b', 'b.pdf') };

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[1]?.resolve({ ok: true, value: fakeDocument('b.pdf') });
      await Promise.resolve();
    });

    expect(closed).toEqual(['a.pdf']);
    expect(result.current.state).toMatchObject({ status: 'ready', documentId: 'id-b' });
  });

  it('discards a document that finishes opening after the reader moved on', async () => {
    const bridge = createBridge();

    // An engine that does not stop when it is told to: the request number,
    // not the abort, is what must protect the reader here.
    behaviour.honourAbort = false;

    bridge.dialogResult = { status: 'opened', document: payload('id-slow', 'slow.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });

    bridge.dialogResult = { status: 'opened', document: payload('id-fast', 'fast.pdf') };

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });

    // The second document arrives first, then the abandoned first one.
    await act(async () => {
      pendingOpens[1]?.resolve({ ok: true, value: fakeDocument('fast.pdf') });
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('slow.pdf') });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({ status: 'ready', documentId: 'id-fast' });
    // The stale document was closed rather than displayed.
    expect(closed).toContain('slow.pdf');
  });

  it('cancels an open and goes back to the start screen, not to an error', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'huge.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });

    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('empty');
    });
  });

  it('aborts an in-flight open when the reader closes the reader', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'huge.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.close();
    });

    expect(pendingOpens[0]?.source.signal?.aborted).toBe(true);
    expect(result.current.state.status).toBe('empty');
  });

  it('asks for a password and retries the same bytes with it', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'locked.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({
        ok: false,
        error: {
          kind: 'password-required',
          message: 'This document is password protected.',
          cause: 'PasswordException',
        },
      });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({ status: 'password', name: 'locked.pdf' });

    await act(async () => {
      void result.current.submitPassword('open sesame');
      await Promise.resolve();
    });

    expect(pendingOpens[1]?.source.password).toBe('open sesame');

    await act(async () => {
      pendingOpens[1]?.resolve({ ok: true, value: fakeDocument('locked.pdf') });
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe('ready');
  });

  it('reports a document that cannot be opened, keeping the engine wording separate', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'broken.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({
        ok: false,
        error: {
          kind: 'corrupt',
          message: 'This document could not be read.',
          cause: 'InvalidPDFException',
        },
      });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({
      status: 'failed',
      name: 'broken.pdf',
      message: 'This document could not be read.',
      cause: 'InvalidPDFException',
    });
  });

  it('surfaces a main-process refusal without reaching the engine', async () => {
    const bridge = createBridge();

    // M7.2: the main process sends a closed reason code and the file's
    // own name; the sentence is composed here. The assertion is the same
    // one it always was — the refusal is shown and the engine is never
    // reached — written against the vocabulary that replaced the string.
    bridge.dialogResult = { status: 'unreadable', reason: 'not-a-file', name: 'books' };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      await result.current.openDialog();
    });

    expect(result.current.state).toMatchObject({
      status: 'failed',
      name: 'books',
      message: 'books could not be opened. Choose a PDF file rather than a folder.',
    });
    expect(pendingOpens).toHaveLength(0);
  });

  it('does nothing when the reader cancels the file dialog', async () => {
    const bridge = createBridge();

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      await result.current.openDialog();
    });

    expect(result.current.state.status).toBe('empty');
  });

  it('explains itself when there is no desktop bridge at all', async () => {
    const { result } = renderHook(() => useReaderDocument(null));

    await act(async () => {
      await result.current.openDialog();
    });

    expect(result.current.state.status).toBe('failed');
    expect(result.current.state).toHaveProperty(
      'message',
      'The desktop bridge is unavailable, so no document can be opened.',
    );
  });

  it('reopens the document that was open last time, on launch', async () => {
    const bridge = createBridge({
      getReaderState: () =>
        Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, recents: [], lastDocumentId: 'id-last' }),
    });

    bridge.recentResult = { status: 'opened', document: payload('id-last', 'last.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('last.pdf') });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({ status: 'ready', documentId: 'id-last' });
  });

  it('prefers a document named on the command line over the remembered one', async () => {
    const bridge = createBridge({
      getInitialDocument: () =>
        Promise.resolve<DocumentRequestResult>({
          status: 'opened',
          document: payload('id-cli', 'cli.pdf'),
        }),
      getReaderState: () =>
        Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, recents: [], lastDocumentId: 'id-last' }),
    });

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('cli.pdf') });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({ status: 'ready', documentId: 'id-cli' });
    expect(pendingOpens).toHaveLength(1);
  });

  it('stays on the start screen when the remembered document has disappeared', async () => {
    const bridge = createBridge({
      getReaderState: () =>
        Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, recents: [], lastDocumentId: 'id-gone' }),
    });

    bridge.recentResult = { status: 'unreadable', reason: 'missing', name: 'gone.pdf' };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    expect(result.current.state.status).toBe('empty');
    expect(pendingOpens).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- *
   * M7.2: an explicit request is answered; a silent restore stays silent
   * ---------------------------------------------------------------- */

  it('tells the reader when a document named on the command line is missing', async () => {
    const bridge = createBridge({
      getInitialDocument: () =>
        Promise.resolve<DocumentRequestResult>({
          status: 'unreadable',
          reason: 'missing',
          name: 'Medical Report 2026.pdf',
        }),
      getReaderState: () =>
        Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, lastDocumentId: 'id-other' }),
    });

    bridge.recentResult = { status: 'opened', document: payload('id-other', 'other.pdf') };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    // R3: the start screen used to appear as though nothing had been asked
    // for — and, worse, the remembered document would have opened instead.
    expect(result.current.state).toMatchObject({
      status: 'failed',
      message:
        'Medical Report 2026.pdf could not be opened. It may have been moved, renamed or deleted.',
    });
    expect(pendingOpens).toHaveLength(0);
  });

  it('reports an unreadable command-line document without naming a reason it cannot act on', async () => {
    const bridge = createBridge({
      getInitialDocument: () =>
        Promise.resolve<DocumentRequestResult>({
          status: 'unreadable',
          reason: 'unreadable',
          name: 'locked.pdf',
        }),
    });

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    expect(result.current.state).toMatchObject({
      status: 'failed',
      message:
        'locked.pdf could not be opened. Check that you have permission to open it, then try again.',
    });
  });

  it('still starts normally when no document was named on the command line', async () => {
    const bridge = createBridge();

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    // `none` is not a failure: it is how the application is usually
    // launched, and it must not raise the explicit-open message.
    expect(result.current.state.status).toBe('empty');
  });

  it('stays silent when the document being restored has disappeared', async () => {
    const bridge = createBridge({
      getReaderState: () =>
        Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, lastDocumentId: 'id-gone' }),
    });

    bridge.recentResult = { status: 'unreadable', reason: 'missing', name: 'gone.pdf' };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();
    await settle();

    // The distinction R3 asked for, from the other side: nobody asked for
    // this document in this session, so the start screen stays a start
    // screen rather than becoming an alarm.
    expect(result.current.state.status).toBe('empty');
    expect(result.current.state).not.toMatchObject({ status: 'failed' });
  });

  it('answers an explicit recent open that fails, unlike the silent restore', async () => {
    const bridge = createBridge();

    bridge.recentResult = { status: 'unreadable', reason: 'missing', name: 'gone.pdf' };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await settle();

    await act(async () => {
      await result.current.openRecent('id-gone');
    });

    expect(result.current.state).toMatchObject({
      status: 'failed',
      message: 'gone.pdf could not be opened. It may have been moved, renamed or deleted.',
    });
  });

  it('names no file when the main process could not identify one', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'unreadable', reason: 'unknown', name: null };

    const { result } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      await result.current.openDialog();
    });

    expect(result.current.state).toMatchObject({
      status: 'failed',
      message:
        'That document could not be opened. Try opening it again, or choose another document.',
    });
  });

  it('closes the open document when the reader is unmounted', async () => {
    const bridge = createBridge();

    bridge.dialogResult = { status: 'opened', document: payload('id-a', 'a.pdf') };

    const { result, unmount } = renderHook(() => useReaderDocument(bridge));

    await act(async () => {
      void result.current.openDialog();
      await Promise.resolve();
    });
    await act(async () => {
      pendingOpens[0]?.resolve({ ok: true, value: fakeDocument('a.pdf') });
      await Promise.resolve();
    });

    unmount();

    expect(closed).toEqual(['a.pdf']);
  });
});
