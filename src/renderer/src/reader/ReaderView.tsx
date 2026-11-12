import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import {
  DEFAULT_PREFERENCES,
  resolveDefaultZoom,
  type Preferences,
} from '@core/persistence/preferences';
import { DEFAULT_ZOOM, type ReadingPosition, type ZoomState } from '@core/persistence/types';
import { NO_TEXT_LAYER_MESSAGE, PAGE_WITHOUT_TEXT_MESSAGE } from '@core/pdf/messages';
import type { DesktopBridge, StateWriteHealth } from '@shared/ipc/contracts';

import { useExplainInContext } from './ai/useExplainInContext';
import { useDictionaryLookup } from './dictionary/useDictionaryLookup';
import { WordDefinitionPopup } from './dictionary/WordDefinitionPopup';
import { createPageRegistry } from './interaction/pageRegistry';
import { useWordInteraction } from './interaction/useWordInteraction';
import {
  useOccurrenceNavigation,
  type NavigationOutcome,
  type OccurrenceTarget,
} from './vocabulary/useOccurrenceNavigation';
import { useSaveWord } from './vocabulary/useSaveWord';
import {
  createPageLayout,
  PAGE_GAP,
  currentPageAt,
  offsetOfPageTop,
  offsetOfPosition,
  pageAt,
  positionAtOffset,
  visiblePageRange,
  type ReadingPoint,
} from './model/pageLayout';
import { livePageWindow, pagesInWindow } from './model/pageWindow';
import { nextZoomLevel, previousZoomLevel, resolveScale } from './model/zoom';
import { PageSurface, type PageSpan } from './PageSurface';
import { rectsForSpan } from './pdf/textRanges';
import { runTextLayerSelfCheck, type SelfCheckReport } from './pdf/selfCheck';
import { Message } from '../ui/Message';

import { DeveloperDiagnostics } from './DeveloperDiagnostics';
import { ReaderToolbar } from './ReaderToolbar';
import { RecentDocuments } from './RecentDocuments';
import type { CommandSource } from '../app/commandBus';
import { Icon } from '../ui/Icon';

import { highlightAt, isBookmarked, type Highlight } from '@core/annotations/annotations';
import { AnnotationPopup, type PopupAnchor } from './annotations/AnnotationPopup';
import { selectionParts, textPlaceAtPoint } from './annotations/selectionParts';
import { useAnnotations, type NewSelection } from './annotations/useAnnotations';
import { EpubPageSurface } from './epub/EpubPageSurface';
import { isEpub } from './epub/epubDocument';
import { PrintDialog } from './print/PrintDialog';
import { ReaderSidebar, type SidebarTab } from './sidebar/ReaderSidebar';
import { NO_VOICE_MESSAGE, useReadAloud } from './speech/useReadAloud';
import { useJumpHistory } from './useJumpHistory';
import { useViewMode } from './useViewMode';
import { SearchPanel } from './SearchPanel';
import { useDocumentOutline } from './useDocumentOutline';
import { useDocumentSearch } from './useDocumentSearch';
import { useDocumentTextPresence } from './useDocumentTextPresence';
import { useGestureZoom } from './useGestureZoom';
import { useLookupHint } from './useLookupHint';
import { useSavedWordCounts } from './useSavedWordCounts';
import { usePageMetrics } from './usePageMetrics';
import { useReaderDocument } from './useReaderDocument';
import { useReadingPosition } from './useReadingPosition';
import { useRecentDocuments } from './useRecentDocuments';
import { useScrollViewport } from './useScrollViewport';
import { WordAnnouncement } from './WordAnnouncement';

/**
 * The reading surface.
 *
 * It composes the reader rather than implementing it: the document lifecycle,
 * page geometry, the live-page policy, search, persistence and word
 * interaction are each owned by their own module and tested there. What is
 * left here is the wiring and the few decisions that only make sense with
 * everything in one place — which page is current, when the view scrolls
 * itself, and what the keyboard does.
 */

/**
 * The scrolling document region, named so the skip link can hand focus to
 * it (A11Y-10). It is exported rather than written twice: the shell renders
 * the link and the reader renders the target, and a drifting string would
 * fail silently — the link would simply do nothing.
 */
/** The largest an EPUB is made by "fit width" or "fit page". */
const EPUB_FIT_LIMIT = 1.3;

export const DOCUMENT_SCROLLER_ID = 'document-scroller';

/**
 * The collapsible part of the reading-details panel (CTL-8). The toggle
 * points at it with `aria-controls`, so the two have to agree on one id.
 */
/** Long documents are sampled rather than checked page by page. */
const selfCheckPages = (pageCount: number): number[] => {
  if (pageCount <= 20) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const step = Math.floor(pageCount / 20);

  return Array.from({ length: 20 }, (_, index) => Math.min(pageCount, 1 + index * step));
};

/*
 * Written out rather than assembled, so that the stylesheet tests can see
 * that every tint has a rule and every rule a user.
 */
const PAGE_TINT_CLASS: Readonly<Record<Preferences['pageTint'], string>> = {
  original: 'reader__pages',
  sepia: 'reader__pages reader__pages--sepia',
  dimmed: 'reader__pages reader__pages--dimmed',
  dark: 'reader__pages reader__pages--dark',
};

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** What the bar by a selection or a highlight is showing. */
type AnnotationPopupState =
  | {
      readonly kind: 'selection';
      readonly anchor: PopupAnchor;
      readonly parts: readonly NewSelection[];
    }
  | {
      readonly kind: 'highlight';
      readonly anchor: PopupAnchor;
      readonly id: string;
      readonly noteOpen: boolean;
    };

export interface ReaderViewProps {
  readonly bridge: DesktopBridge | null;
  /** A place in a document the library asked to return to. */
  readonly occurrence?: OccurrenceTarget | null;
  /** How that journey ended, so the library can say so. */
  readonly onOccurrenceOutcome?: (outcome: NavigationOutcome) => void;
  /**
   * The stored preferences (ADR-031). Two of the four reach the reader:
   * the default zoom of a document it has never opened before, and
   * whether the diagnostics disclosure starts expanded.
   *
   * Defaulted so that a caller which does not care about settings — every
   * test that predates them — gets the behaviour that shipped before the
   * preference existed.
   */
  readonly preferences?: Preferences;
  /**
   * Told whether reading state is reaching the disk (M7.2, ADR-034).
   *
   * The reader surface causes two kinds of write — a reading position and
   * forgetting a recent document — but it does not own the notice: one
   * notice per session, for every write in the application, belongs to
   * the shell. Optional, so a caller that predates it behaves as before.
   */
  readonly onWriteHealth?: (health: StateWriteHealth) => void;
  /**
   * The application's own controls (saved words, settings). They sit at
   * the end of the one bar the window has, whether or not a document is
   * open.
   */
  readonly trailing?: ReactNode;
  /**
   * The application's notices. They are shown in the same place as the
   * reader's own, directly under the bar, so that everything the reader
   * is told arrives in one spot.
   */
  readonly notices?: ReactNode;
  /** Commands from the application menu and the keyboard. */
  readonly commands?: CommandSource;
  /** Reading mode: the bar and everything beside the pages are put away. */
  readonly readingMode?: boolean;
  readonly onExitReadingMode?: () => void;
}

export const ReaderView = ({
  bridge,
  occurrence = null,
  onOccurrenceOutcome,
  preferences = DEFAULT_PREFERENCES,
  onWriteHealth,
  trailing,
  notices,
  commands,
  readingMode = false,
  onExitReadingMode,
}: ReaderViewProps): ReactElement => {
  const { state, openDialog, openRecent, submitPassword, cancel, close } =
    useReaderDocument(bridge);
  const recents = useRecentDocuments(bridge, onWriteHealth);
  const refreshRecents = recents.refresh;
  const registry = useMemo(() => createPageRegistry(), []);
  const { ref: scrollRef, scrollTop, viewport, scrollTo } = useScrollViewport();

  const [zoom, setZoom] = useState<ZoomState>(DEFAULT_ZOOM);
  const [password, setPassword] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [chosenViewMode, setViewMode] = useViewMode();
  const [popup, setPopup] = useState<AnnotationPopupState | null>(null);
  const [voiceNoticeDismissed, setVoiceNoticeDismissed] = useState(false);
  const readAloud = useReadAloud();
  const [showTextLayer, setShowTextLayer] = useState(false);
  const [selfCheck, setSelfCheck] = useState<SelfCheckReport | null>(null);
  const [renderMilliseconds, setRenderMilliseconds] = useState<number | null>(null);
  const [pagesWithoutText, setPagesWithoutText] = useState<ReadonlySet<number>>(new Set());
  const ready = state.status === 'ready' ? state : null;
  const outline = useDocumentOutline(ready?.document ?? null);
  const textPresence = useDocumentTextPresence(ready?.document ?? null);
  // The reader can put the scan notice away; it stays away for that
  // document and comes back for the next one that needs it.
  const [scanNoticeDismissedFor, setScanNoticeDismissedFor] = useState<unknown>(null);
  const savedWordCounts = useSavedWordCounts(bridge, state.status === 'empty');
  const lookupHint = useLookupHint();
  const dismissLookupHint = lookupHint.dismiss;
  const pageFieldRef = useRef<HTMLInputElement>(null);
  const pdfDocument = ready?.document ?? null;
  const pageCount = ready?.pageCount ?? 0;
  const documentId = ready?.documentId ?? null;

  const metrics = usePageMetrics(pdfDocument, pageCount);
  const search = useDocumentSearch(pdfDocument, pageCount);
  const positionRecorder = useReadingPosition(
    bridge,
    documentId,
    pageCount === 0 ? null : pageCount,
    onWriteHealth,
  );

  const marks = useAnnotations(bridge, documentId, ready?.name ?? '');
  /*
   * An EPUB has chapters of running text, not pages: there is nothing to
   * set two-up or to turn on its side, so it is always one scrolling
   * column, upright, whatever was chosen for the last PDF.
   */
  const epub = isEpub(pdfDocument) ? pdfDocument : null;
  const viewMode = epub === null ? chosenViewMode : 'continuous';
  const rotation = epub === null ? marks.annotations.rotation : 0;
  const history = useJumpHistory(documentId);

  // A page turned a quarter is as wide as it was tall.
  const sideways = rotation === 90 || rotation === 270;
  const sizes = useMemo(
    () =>
      sideways
        ? metrics.sizes.map((size) => ({ width: size.height, height: size.width }))
        : metrics.sizes,
    [metrics.sizes, sideways],
  );
  const reference = useMemo(() => {
    const one =
      metrics.reference !== null && sideways
        ? { width: metrics.reference.height, height: metrics.reference.width }
        : metrics.reference;

    // "Fit" in the two-page view fits the pair, not one page of it.
    return one !== null && viewMode === 'two'
      ? { width: one.width * 2 + PAGE_GAP, height: one.height }
      : one;
  }, [metrics.reference, sideways, viewMode]);

  const fittedScale = resolveScale(zoom, reference, viewport);
  // "Fit" on a wide window would make a book's type enormous; it stops at
  // a comfortable reading size. Zooming by hand goes as far as it likes.
  const scale =
    epub !== null && zoom.mode !== 'fixed' ? Math.min(fittedScale, EPUB_FIT_LIMIT) : fittedScale;
  const layout = useMemo(
    () =>
      createPageLayout(sizes, scale, PAGE_GAP, {
        mode: viewMode,
        viewportHeight: viewport.height,
      }),
    [sizes, scale, viewMode, viewport.height],
  );

  const currentPage = currentPageAt(layout, scrollTop, viewport.height);
  const visible = visiblePageRange(layout, scrollTop, viewport.height);
  const liveWindow = livePageWindow({ first: visible.first, last: visible.last, pageCount });

  const revealPage = useCallback(
    (pageNumber: number): void => {
      scrollTo(offsetOfPageTop(layout, pageNumber, viewport.height));
    },
    [layout, scrollTo, viewport.height],
  );

  const words = useWordInteraction({
    registry,
    documentId,
    currentPage,
    pageCount,
    revealPage,
  });

  const dictionary = useDictionaryLookup({ bridge, registry, documentId });
  const closeDictionary = dictionary.close;
  const dictionaryOpen = dictionary.state.status !== 'closed';

  const goToPlace = useCallback(
    (pageNumber: number, pageOffsetFraction: number | null): void => {
      // The stored fraction is a hint, not a position: it puts the reader
      // near the word while the page renders, and the highlight does the
      // rest. The remembered reading position is not touched by arriving
      // here.
      scrollTo(
        offsetOfPosition(
          layout,
          { page: pageNumber, pageOffsetFraction: pageOffsetFraction ?? 0 },
          viewport.height,
        ),
      );
    },
    [layout, scrollTo, viewport.height],
  );

  const noOutcome = useCallback((): void => {}, []);

  const navigation = useOccurrenceNavigation({
    target: occurrence,
    documentId,
    documentFailed: state.status === 'failed',
    registry,
    openDocument: openRecent,
    goToPlace,
    onOutcome: onOccurrenceOutcome ?? noOutcome,
  });

  const saveWord = useSaveWord({
    bridge,
    registry,
    documentId,
    pageCount: pageCount === 0 ? null : pageCount,
    request: dictionary.state.request,
    result: dictionary.state.result,
  });

  // Contextual explanation is inert unless a provider was configured
  // outside the application: with none, the hook reports unsupported and
  // the popup renders no control at all.
  const explainInContext = useExplainInContext({
    bridge,
    registry,
    documentId,
    request: dictionary.state.request,
    result: dictionary.state.result,
  });

  /**
   * Where the popup points.
   *
   * Recomputed from the live text layer on every render, so the popup
   * follows the word while the reader scrolls and disappears as soon as the
   * word does. The rectangle is the browser's own measurement of the glyphs
   * (AGENTS.md section 9); no PDF geometry is computed here.
   */
  const dictionaryAnchor = ((): {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null => {
    const request = dictionary.state.request;

    if (request === null) {
      return null;
    }

    const page = registry.get(request.pageNumber);

    if (page === null || page.generation !== request.generation) {
      return null;
    }

    const [rect] = rectsForSpan(page.container, page.layer, request.word.start, request.word.end);

    if (rect === undefined) {
      return null;
    }

    const box = page.container.getBoundingClientRect();

    return {
      left: box.left + rect.left,
      top: box.top + rect.top,
      width: rect.width,
      height: rect.height,
    };
  })();

  // The word scrolled out of the live window, or its page was recycled.
  useEffect(() => {
    if (dictionaryOpen && dictionaryAnchor === null) {
      closeDictionary();
    }
  }, [dictionaryOpen, dictionaryAnchor, closeDictionary]);

  // Moving to another page is navigation, and navigation dismisses.
  useEffect(() => {
    closeDictionary();
  }, [currentPage, closeDictionary]);

  /* ---------------------------------------------------------------- *
   * Scroll position: derived on the way out, restored on the way in.
   * ---------------------------------------------------------------- */

  const { page: readingPage, pageOffsetFraction: readingFraction } = positionAtOffset(
    layout,
    scrollTop,
    viewport.height,
  );
  /** The position as it was before the current render's layout. */
  const position = useRef<ReadingPoint>({
    page: readingPage,
    pageOffsetFraction: readingFraction,
  });
  const pendingRestore = useRef<ReadingPosition | null>(null);
  const restoredFor = useRef<number | null>(null);
  // Anything that moves every page: the size, the arrangement, the turn.
  const arrangement = `${String(scale)}:${viewMode}:${String(rotation)}`;
  const lastScale = useRef(arrangement);

  // Written after the commit, so the layout effect that reacts to a zoom
  // change still sees where the reader was *before* the pages were resized.
  useEffect(() => {
    position.current = { page: readingPage, pageOffsetFraction: readingFraction };
  }, [readingPage, readingFraction]);

  /*
   * What a document with nothing remembered about it opens at (ADR-031).
   *
   * The zoom model itself is untouched: this chooses a starting
   * `ZoomState` of the same shape the reader has always used, and every
   * zoom control keeps working on it afterwards. `last-used` is answered
   * by the zoom that came with this open — the main process reads it from
   * the reader state before recording the open, so it is the zoom of the
   * document read before this one and not this one's own starting point.
   * There is still no second stored value, and still no conflict with
   * reading-position persistence, because a document that *has* a
   * remembered position never consults this at all.
   */
  const openingZoom = useMemo(
    () => resolveDefaultZoom(preferences.defaultZoomMode, ready?.lastUsedZoom ?? null),
    [preferences.defaultZoomMode, ready?.lastUsedZoom],
  );

  // A newly opened document arrives with the position it was left at. Each
  // open is restored once, keyed by the open itself: closing a document and
  // reopening it in the same session has to put the reader back too, and the
  // document id is the same both times.
  useEffect(() => {
    if (ready === null || restoredFor.current === ready.openToken) {
      return;
    }

    restoredFor.current = ready.openToken;
    pendingRestore.current = ready.restored;
    setZoom(ready.restored?.zoom ?? openingZoom);
    setPagesWithoutText(new Set());
    setSelfCheck(null);
    scrollTo(0);
    // `openingZoom` is read only on the open it belongs to: the guard
    // above returns early for every other run, so changing the preference
    // while a document is open never resizes the page under the reader.
  }, [openingZoom, ready, scrollTo]);

  // …and is put back there once the pages up to it have been measured, so
  // the offset is computed against real page heights rather than estimates.
  useEffect(() => {
    const target = pendingRestore.current;

    if (target === null || viewport.height === 0) {
      return;
    }

    if (metrics.measured < Math.min(target.page, pageCount) && metrics.measured < pageCount) {
      return;
    }

    pendingRestore.current = null;
    scrollTo(offsetOfPosition(layout, target, viewport.height));
  }, [layout, metrics.measured, pageCount, scrollTo, viewport.height]);

  // Changing zoom keeps the reader where they were reading.
  useLayoutEffect(() => {
    if (lastScale.current === arrangement) {
      return;
    }

    lastScale.current = arrangement;

    if (pendingRestore.current === null && viewport.height > 0) {
      scrollTo(offsetOfPosition(layout, position.current, viewport.height));
    }
  }, [arrangement, layout, scrollTo, viewport.height]);

  // Remember where we are. Recording is throttled inside the recorder.
  useEffect(() => {
    if (documentId === null || viewport.height === 0 || pendingRestore.current !== null) {
      return;
    }

    positionRecorder.record({ page: readingPage, pageOffsetFraction: readingFraction, zoom });
  }, [documentId, readingPage, readingFraction, zoom, viewport.height, positionRecorder]);

  // The recent list changes whenever a document is opened or left. The
  // position of the document being left has to reach the main process first,
  // or the list would offer the page the reader was on before their last
  // move.
  useEffect(() => {
    void positionRecorder.flush().then(refreshRecents, () => undefined);
  }, [documentId, positionRecorder, refreshRecents]);

  /* ---------------------------------------------------------------- *
   * Search
   * ---------------------------------------------------------------- */

  const currentMatch =
    search.state.currentIndex === null
      ? null
      : (search.state.matches[search.state.currentIndex] ?? null);
  const shownMatch = useRef<string | null>(null);

  useEffect(() => {
    if (currentMatch === null) {
      shownMatch.current = null;
      return;
    }

    const key = `${String(currentMatch.pageNumber)}:${String(currentMatch.start)}`;

    if (shownMatch.current === key) {
      return;
    }

    const page = registry.get(currentMatch.pageNumber);
    const laidOut = pageAt(layout, currentMatch.pageNumber);

    // Before the page is live only its band is known, so the reader is taken
    // to the page; once it has rendered the match itself can be centred.
    if (page === null || laidOut === null) {
      revealPage(currentMatch.pageNumber);
      return;
    }

    const [rect] = rectsForSpan(page.container, page.layer, currentMatch.start, currentMatch.end);

    shownMatch.current = key;
    scrollTo(
      rect === undefined
        ? offsetOfPageTop(layout, currentMatch.pageNumber, viewport.height)
        : laidOut.top + rect.top - viewport.height * 0.35,
    );
  }, [currentMatch, layout, registry, revealPage, scrollTo, viewport.height]);

  const spansFor = useCallback(
    (pageNumber: number): PageSpan[] => {
      // The reader's own highlights go down first, so that a search match
      // or the word under the cursor is drawn over them, not hidden.
      const spans: PageSpan[] = marks.annotations.highlights
        .filter((highlight) => highlight.page === pageNumber)
        .map((highlight) => ({
          start: highlight.start,
          end: highlight.end,
          kind: `mark-${highlight.colour}` as const,
          noted: highlight.note.trim().length > 0,
        }));

      const matches: PageSpan[] = search.state.matches
        .filter((match) => match.pageNumber === pageNumber)
        .map((match) => ({
          start: match.start,
          end: match.end,
          kind:
            currentMatch !== null &&
            match.pageNumber === currentMatch.pageNumber &&
            match.start === currentMatch.start
              ? ('current-match' as const)
              : ('match' as const),
        }));

      spans.push(...matches);

      const found = navigation.highlight;

      if (found !== null && found.pageNumber === pageNumber) {
        spans.push({ start: found.start, end: found.end, kind: 'occurrence' });
      }

      const word = words.interaction?.hit;

      if (
        words.interaction?.source === 'keyboard' &&
        words.interaction.pageNumber === pageNumber &&
        word?.kind === 'word'
      ) {
        spans.push({ start: word.word.start, end: word.word.end, kind: 'cursor' });
      }

      return spans;
    },
    [
      marks.annotations.highlights,
      search.state.matches,
      currentMatch,
      navigation.highlight,
      words.interaction,
    ],
  );

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  const zoomIn = useCallback((): void => {
    setZoom({ mode: 'fixed', scale: nextZoomLevel(scale) });
  }, [scale]);

  // Pinch on a trackpad, or Ctrl + wheel: any zoom, not only the listed ones.
  const zoomTo = useCallback((next: number): void => {
    setZoom({ mode: 'fixed', scale: next });
  }, []);

  useGestureZoom(scrollRef, scale, zoomTo, ready !== null);

  const zoomOut = useCallback((): void => {
    setZoom({ mode: 'fixed', scale: previousZoomLevel(scale) });
  }, [scale]);

  // The window's title names the open document, as every reader's does;
  // the application's own name no longer takes a row of the window to say.
  const documentName = ready?.name ?? null;

  useEffect(() => {
    document.title = documentName === null ? 'Lexleaf' : `${documentName} — Lexleaf`;
  }, [documentName]);

  // The reader has looked a word up: the tip that says they can has done
  // its work.
  useEffect(() => {
    if (dictionaryOpen) {
      dismissLookupHint();
    }
  }, [dictionaryOpen, dismissLookupHint]);

  /*
   * Commands from the menu and the keyboard. Each does exactly what the
   * control in the bar does; the ones that act on a document do nothing
   * when none is open.
   */
  const hasDocument = ready !== null;
  const paged = epub === null;
  const hasOutline = outline.length > 0;

  /** Goes to a page from somewhere else in the book, remembering where from. */
  const jumpToPage = useCallback(
    (pageNumber: number): void => {
      // Turning to the next page or pair is reading on, not a jump.
      if (Math.abs(pageNumber - position.current.page) > 2) {
        history.remember(position.current);
      }

      revealPage(pageNumber);
    },
    [history, revealPage],
  );

  const goBack = useCallback((): void => {
    const place = history.back();

    if (place !== null) {
      scrollTo(offsetOfPosition(layout, place, viewport.height));
    }
  }, [history, layout, scrollTo, viewport.height]);

  const goToHighlight = useCallback(
    (highlight: Highlight): void => {
      history.remember(position.current);

      const page = registry.get(highlight.page);
      const laidOut = pageAt(layout, highlight.page);
      const [rect] =
        page === null
          ? []
          : rectsForSpan(page.container, page.layer, highlight.start, highlight.end);

      scrollTo(
        rect === undefined || laidOut === null
          ? offsetOfPageTop(layout, highlight.page, viewport.height)
          : laidOut.top + rect.top - viewport.height * 0.35,
      );
    },
    [history, layout, registry, scrollTo, viewport.height],
  );

  /** Opens the sidebar on a section, or closes it if that section is showing. */
  const toggleSidebar = useCallback(
    (tab: SidebarTab | null): void => {
      setSidebarTab((current) => {
        if (tab === null) {
          return current === null ? (hasOutline || !paged ? 'contents' : 'pages') : null;
        }

        return current === tab ? null : tab;
      });
    },
    [hasOutline, paged],
  );

  const toggleBookmark = useCallback((): void => {
    if (!hasDocument) {
      return;
    }

    // A bookmark is named after the chapter it falls in, where there is one.
    const chapter = [...outline]
      .filter((entry) => entry.pageNumber !== null && entry.pageNumber <= currentPage)
      .sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0))
      .pop();

    marks.toggleBookmark(currentPage, chapter?.title ?? '');
  }, [hasDocument, outline, currentPage, marks]);

  const rotatePages = marks.rotate;
  const speak = readAloud.speak;
  const stopSpeaking = readAloud.stop;

  /** Reads the selected text, or failing that the word under the cursor. */
  const readSelectionAloud = useCallback((): void => {
    const selected = window.getSelection()?.toString().trim() ?? '';
    const word = words.interaction?.hit;
    const text = selected.length > 0 ? selected : word?.kind === 'word' ? word.word.display : '';

    if (text.length > 0) {
      setVoiceNoticeDismissed(false);
      speak(text);
    }
  }, [words.interaction, speak]);

  // The bar belongs to a place on screen; once the page moves it is stale.
  useEffect(() => {
    setPopup(null);
  }, [scrollTop, documentId, arrangement]);

  // A looked-up word and a selection bar would sit on top of each other.
  useEffect(() => {
    if (dictionaryOpen) {
      setPopup(null);
    }
  }, [dictionaryOpen]);

  // Nothing carries on being read from a book that has been closed.
  useEffect(() => {
    stopSpeaking();
    setPrintOpen(false);
  }, [documentId, stopSpeaking]);

  const popupHighlight =
    popup?.kind === 'highlight'
      ? (marks.annotations.highlights.find((highlight) => highlight.id === popup.id) ?? null)
      : null;

  useEffect(() => {
    if (commands === undefined) {
      return undefined;
    }

    return commands.subscribe((command) => {
      switch (command) {
        case 'open-document':
          void openDialog();
          break;
        case 'close-document':
          if (hasDocument) {
            void close();
          }
          break;
        case 'find':
          if (hasDocument) {
            closeDictionary();
            setSearchOpen(true);
          }
          break;
        case 'go-to-page':
          pageFieldRef.current?.focus();
          pageFieldRef.current?.select();
          break;
        case 'toggle-contents':
          if (hasDocument) {
            toggleSidebar('contents');
          }
          break;
        case 'toggle-thumbnails':
          if (hasDocument && paged) {
            toggleSidebar('pages');
          }
          break;
        case 'toggle-bookmarks':
          if (hasDocument) {
            toggleSidebar('bookmarks');
          }
          break;
        case 'toggle-notes':
          if (hasDocument) {
            toggleSidebar('notes');
          }
          break;
        case 'toggle-bookmark':
          toggleBookmark();
          break;
        case 'go-back':
          goBack();
          break;
        case 'print':
          if (hasDocument && paged) {
            setPrintOpen(true);
          }
          break;
        case 'view-continuous':
          setViewMode('continuous');
          break;
        case 'view-single':
          setViewMode('single');
          break;
        case 'view-two':
          setViewMode('two');
          break;
        case 'rotate-right':
          if (hasDocument && paged) {
            rotatePages(1);
          }
          break;
        case 'rotate-left':
          if (hasDocument && paged) {
            rotatePages(-1);
          }
          break;
        case 'read-aloud':
          if (hasDocument) {
            readSelectionAloud();
          }
          break;
        case 'zoom-in':
          zoomIn();
          break;
        case 'zoom-out':
          zoomOut();
          break;
        case 'zoom-fit-width':
          setZoom({ mode: 'fit-width', scale });
          break;
        case 'zoom-fit-page':
          setZoom({ mode: 'fit-page', scale });
          break;
        default:
          // The shell's commands: saved words, settings, export, reading mode.
          break;
      }
    });
  }, [
    commands,
    openDialog,
    close,
    hasDocument,
    closeDictionary,
    zoomIn,
    zoomOut,
    scale,
    toggleSidebar,
    toggleBookmark,
    goBack,
    setViewMode,
    rotatePages,
    readSelectionAloud,
    paged,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA');

      if (event.key === 'Escape') {
        // The popup is dismissed first: one Escape, one dismissal.
        if (dictionaryOpen) {
          closeDictionary();
          return;
        }

        setPopup(null);
        stopSpeaking();

        setSearchOpen(false);
        words.clear();
        return;
      }

      if (typing) {
        return;
      }

      const accelerator = event.ctrlKey || event.metaKey;

      if (accelerator && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        zoomIn();
      } else if (accelerator && event.key === '-') {
        event.preventDefault();
        zoomOut();
      } else if (accelerator && event.key === '0') {
        event.preventDefault();
        setZoom({ mode: 'fit-width', scale });
      } else if (accelerator && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        closeDictionary();
        setSearchOpen(true);
      } else if (event.key === 'Enter' && words.interaction !== null && !dictionaryOpen) {
        // The keyboard route to a definition: Alt with the arrow keys walks
        // the words, Enter asks what one means.
        event.preventDefault();
        dictionary.open(words.interaction);
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        words.moveCursor('forward');
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        words.moveCursor('backward');
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [scale, words, zoomIn, zoomOut, dictionary, dictionaryOpen, closeDictionary, stopSpeaking]);

  /* ---------------------------------------------------------------- *
   * Page callbacks
   * ---------------------------------------------------------------- */

  const handleRendered = useCallback((_pageNumber: number, milliseconds: number): void => {
    setRenderMilliseconds(milliseconds);
  }, []);

  const handleTextPresence = useCallback((pageNumber: number, hasText: boolean): void => {
    setPagesWithoutText((current) => {
      const has = current.has(pageNumber);

      if (hasText === !has) {
        return current;
      }

      const next = new Set(current);

      if (hasText) {
        next.delete(pageNumber);
      } else {
        next.add(pageNumber);
      }

      return next;
    });
  }, []);

  const handlePassword = (event: FormEvent): void => {
    event.preventDefault();
    void submitPassword(password);
    setPassword('');
  };

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const scanNotice: 'document' | 'page' | null =
    ready === null
      ? null
      : textPresence === 'none'
        ? scanNoticeDismissedFor === ready.document
          ? null
          : 'document'
        : pagesWithoutText.has(currentPage)
          ? 'page'
          : null;

  const loadingProgress =
    state.status === 'loading' && state.progress.total > 0
      ? `${megabytes(state.progress.loaded)} of ${megabytes(state.progress.total)}`
      : null;

  return (
    <main className="reader">
      {/*
        One bar. With a document open it is the toolbar, with the
        application's own controls at its end; with none, those controls
        are all there is to show. Reading mode puts it away entirely.
      */}
      {ready === null && !readingMode && trailing !== undefined && (
        <header className="reader__bar reader__bar--idle">{trailing}</header>
      )}

      {readingMode && (
        <button
          type="button"
          className="control reader__exit-reading"
          data-testid="exit-reading-mode"
          onClick={onExitReadingMode}
        >
          Exit reading mode
        </button>
      )}

      {ready !== null && !readingMode && (
        <ReaderToolbar
          pageFieldRef={pageFieldRef}
          trailing={trailing}
          documentName={ready.name}
          currentPage={currentPage}
          pageCount={pageCount}
          zoom={zoom}
          scale={scale}
          searchOpen={searchOpen}
          paged={paged}
          sidebarOpen={sidebarTab !== null}
          onToggleSidebar={(): void => {
            toggleSidebar(null);
          }}
          canGoBack={history.canGoBack}
          onGoBack={goBack}
          bookmarked={isBookmarked(marks.annotations, currentPage)}
          onToggleBookmark={toggleBookmark}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onRotate={(): void => {
            rotatePages(1);
          }}
          onPrint={(): void => {
            setPrintOpen(true);
          }}
          onGoToPage={jumpToPage}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomChange={setZoom}
          onToggleSearch={(): void => {
            closeDictionary();
            setSearchOpen((open) => !open);
          }}
        />
      )}

      {ready !== null && searchOpen && (
        <SearchPanel
          state={search.state}
          onSearch={(text, caseSensitive): void => {
            search.run({ text, caseSensitive }, currentPage);
          }}
          onNext={search.next}
          onPrevious={search.previous}
          onClose={(): void => {
            setSearchOpen(false);
            search.clear();
          }}
        />
      )}

      {/*
        Everything the reader is told, in one place, directly under the
        bar: the application's notices first, then the reader's own. The
        region is capped and scrolls within itself, so that however many
        notices there are, the pages keep most of the window.
      */}
      <div className="reader__notices" data-testid="notices">
        {notices}

        {ready !== null && lookupHint.visible && (
          <div className="reader__notice" data-testid="lookup-hint">
            <Message kind="info">
              Tip: double-click any word in the book to see what it means. You can save it from
              there.
            </Message>
            <button type="button" className="control" onClick={lookupHint.dismiss}>
              Got it
            </button>
          </div>
        )}

        {/*
          Why words cannot be looked up, when they cannot.

          A document with no text anywhere — a scan — is told so once, for
          the whole document, wherever the reader is in it, until they put
          the notice away. A document that has text but not on this page (a
          cover, a plate) gets the shorter line, for as long as that page is
          the one being read. Both sit above the pages, across the width of
          the reader, and neither is announced: they describe the document,
          they are not events (6.5, audit C-5).
        */}
        {ready !== null && marks.writeFailed && (
          <div className="reader__notice" data-testid="annotations-write-failed">
            <Message kind="problem">
              Your highlights and bookmarks could not be saved to disk. They are kept while this
              window stays open; export your notes to keep a copy.
            </Message>
          </div>
        )}
        {readAloud.status === 'speaking' && (
          <div className="reader__notice" data-testid="read-aloud">
            <Message kind="busy">Reading aloud…</Message>
            <button type="button" className="control" onClick={stopSpeaking}>
              Stop
            </button>
          </div>
        )}
        {readAloud.status === 'unavailable' && !voiceNoticeDismissed && (
          <div className="reader__notice" data-testid="read-aloud-unavailable">
            <Message kind="info">{NO_VOICE_MESSAGE}</Message>
            <button
              type="button"
              className="control"
              onClick={(): void => {
                setVoiceNoticeDismissed(true);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {ready !== null && scanNotice === 'document' && (
          <div className="reader__notice" data-testid="scan-notice">
            <Message kind="info" announce={false}>
              {NO_TEXT_LAYER_MESSAGE}
            </Message>
            <button
              type="button"
              className="control"
              onClick={(): void => {
                setScanNoticeDismissedFor(ready.document);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {ready !== null && scanNotice === 'page' && (
          <div className="reader__notice">
            <Message kind="info" announce={false}>
              {PAGE_WITHOUT_TEXT_MESSAGE}
            </Message>
          </div>
        )}
      </div>

      <div className="reader__body">
        {ready !== null && sidebarTab !== null && !readingMode && (
          <ReaderSidebar
            tab={paged || sidebarTab !== 'pages' ? sidebarTab : 'contents'}
            paged={paged}
            onTabChange={setSidebarTab}
            onClose={(): void => {
              setSidebarTab(null);
            }}
            document={ready.document}
            outline={outline}
            sizes={sizes}
            rotation={rotation}
            currentPage={currentPage}
            annotations={marks.annotations}
            onGoToPage={jumpToPage}
            onGoToHighlight={goToHighlight}
            onRemoveBookmark={(bookmark): void => {
              marks.toggleBookmark(bookmark.page, bookmark.label);
            }}
            onRemoveHighlight={(highlight): void => {
              marks.remove(highlight.id);
            }}
            {...(marks.exportDocument === undefined ? {} : { onExport: marks.exportDocument })}
          />
        )}
        <div
          className="reader__scroller"
          ref={scrollRef}
          id={DOCUMENT_SCROLLER_ID}
          tabIndex={0}
          role="region"
          aria-label="Document"
          onPointerDown={(event): void => {
            setPopup(null);
            words.handlePointerDown({ clientX: event.clientX, clientY: event.clientY });
          }}
          onMouseUp={(event): void => {
            words.handleSelectionChanged();

            // A double-click looks the word up; the bar is for a selection
            // the reader dragged out, or for a highlight they clicked.
            if (ready === null || event.detail === 2 || event.button !== 0) {
              return;
            }

            const selection = window.getSelection();

            if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
              const parts = selectionParts(
                {
                  startNode: selection.anchorNode,
                  startOffset: selection.anchorOffset,
                  endNode: selection.focusNode,
                  endOffset: selection.focusOffset,
                },
                registry,
              );
              const box = selection.getRangeAt(0).getBoundingClientRect();

              if (parts.length > 0) {
                setPopup({
                  kind: 'selection',
                  parts,
                  anchor: { left: box.left, top: box.top, width: box.width, height: box.height },
                });
              }

              return;
            }

            const place = textPlaceAtPoint(document, registry, event.clientX, event.clientY);
            const existing =
              place === null ? null : highlightAt(marks.annotations, place.page, place.index);

            if (existing !== null) {
              setPopup({
                kind: 'highlight',
                id: existing.id,
                noteOpen: existing.note.trim().length > 0,
                anchor: { left: event.clientX, top: event.clientY - 10, width: 0, height: 20 },
              });
            }
          }}
          onDoubleClick={(): void => {
            // Single click keeps its Milestone 2 behaviour; the second click
            // is what asks for a definition.
            const resolved = words.handleSelectionChanged();

            if (resolved !== null) {
              dictionary.open(resolved);
            }
          }}
        >
          {state.status === 'empty' && (
            <section className="start" aria-label="Start reading">
              <h2>Open a PDF or EPUB to begin</h2>
              <p className="start__hint">
                While reading, double-click any word to see its definition, then save it for later.
              </p>
              <button
                type="button"
                className="control start__open"
                onClick={(): void => void openDialog()}
              >
                <Icon name="open" />
                Open…
              </button>
              <p className="start__hint">
                You can also drop a file anywhere on this window, or right-click one and choose Open
                with Lexleaf.
              </p>
              <h3>Recent documents</h3>
              <RecentDocuments
                recents={recents.snapshot.recents}
                onOpen={(id): void => void openRecent(id)}
                onForget={recents.forget}
                savedWords={savedWordCounts}
              />
            </section>
          )}

          {state.status === 'loading' && (
            <section className="start" aria-label="Opening document" aria-live="polite">
              <h2>Opening {state.name}…</h2>
              {loadingProgress !== null && <p className="start__progress">{loadingProgress}</p>}
              <button type="button" className="control" onClick={cancel}>
                Cancel
              </button>
            </section>
          )}

          {state.status === 'failed' && (
            <section className="start" aria-label="Document could not be opened">
              {/*
                The specification's wording (§ 20) is the whole of what the
                reader is told: it already names the three things that can
                be wrong with a file. Beneath it, until the 6.5 closure
                pass, sat `state.cause` — the engine's own
                `name: message`, which for a missing file is a filesystem
                path and for an unknown one is an exception string. The
                6.5 acceptance audit raised it as C-3, and 6.5 had just
                made this an `alert`, so it was spoken too.

                The classification and the engine wording are untouched
                and the reader state still carries `cause`
                (`useReaderDocument`); what changed is that the failure
                screen no longer prints it. Developer instrumentation has
                had one home since 6.4 — the diagnostics disclosure — and
                that disclosure belongs to an open document, not to a
                document that never opened.
              */}
              <Message kind="problem">{state.message}</Message>
              <button type="button" className="control" onClick={(): void => void openDialog()}>
                Open another file…
              </button>
            </section>
          )}

          {state.status === 'password' && (
            <form className="reader__password" onSubmit={handlePassword}>
              <Message kind="info">{state.message}</Message>
              <label>
                Password
                <input
                  className="control control--field"
                  type="password"
                  value={password}
                  onChange={(event): void => {
                    setPassword(event.target.value);
                  }}
                />
              </label>
              <button type="submit" className="control">
                Open
              </button>
            </form>
          )}

          {ready !== null && (
            <div
              className={PAGE_TINT_CLASS[preferences.pageTint]}
              style={{
                height: `${String(layout.totalHeight)}px`,
                width: `${String(layout.contentWidth)}px`,
              }}
            >
              {pagesInWindow(liveWindow).map((pageNumber) => {
                const box = pageAt(layout, pageNumber);

                if (box === null) {
                  return null;
                }

                return epub !== null ? (
                  <EpubPageSurface
                    key={pageNumber}
                    document={epub}
                    documentId={ready.documentId}
                    pageNumber={pageNumber}
                    scale={scale}
                    top={box.top}
                    width={box.width}
                    height={box.height}
                    registry={registry}
                    spans={spansFor(pageNumber)}
                    onTextPresence={handleTextPresence}
                  />
                ) : (
                  <PageSurface
                    key={pageNumber}
                    document={ready.document}
                    documentId={ready.documentId}
                    pageNumber={pageNumber}
                    scale={scale}
                    top={box.top}
                    left={box.left}
                    rotation={rotation}
                    width={box.width}
                    height={box.height}
                    registry={registry}
                    spans={spansFor(pageNumber)}
                    showTextLayer={showTextLayer}
                    onRendered={handleRendered}
                    onTextPresence={handleTextPresence}
                  />
                );
              })}
            </div>
          )}
        </div>

        <WordAnnouncement interaction={words.interaction} />
        {!import.meta.env.PROD && ready !== null && (
          <DeveloperDiagnostics
            startOpen={preferences.showDeveloperDiagnostics === 'on'}
            interaction={words.interaction}
            loadMilliseconds={ready.loadMilliseconds}
            renderMilliseconds={renderMilliseconds}
            pageCount={pageCount}
            pagesMeasured={metrics.measured}
            pagesLive={registry.livePages().length}
            showTextLayer={showTextLayer}
            onShowTextLayerChange={setShowTextLayer}
            onRunSelfCheck={(): void => {
              void runTextLayerSelfCheck(ready.document, selfCheckPages(pageCount)).then(
                setSelfCheck,
                () => undefined,
              );
            }}
            selfCheck={selfCheck}
          />
        )}

        {dictionaryOpen && dictionaryAnchor !== null && dictionary.state.request !== null && (
          <WordDefinitionPopup
            anchor={dictionaryAnchor}
            displayWord={dictionary.state.request.word.display}
            loading={dictionary.state.status === 'loading'}
            result={dictionary.state.result}
            onClose={closeDictionary}
            onListen={(): void => {
              setVoiceNoticeDismissed(false);
              speak(dictionary.state.request?.word.display ?? '');
            }}
            save={saveWord}
            explain={explainInContext}
          />
        )}
        {ready !== null &&
          popup !== null &&
          (popup.kind === 'selection' || popupHighlight !== null) && (
            <AnnotationPopup
              anchor={popup.anchor}
              highlight={popupHighlight}
              noteOpen={popup.kind === 'highlight' && popup.noteOpen}
              onColour={(colour): void => {
                if (popup.kind === 'highlight') {
                  marks.recolour(popup.id, colour);

                  return;
                }

                marks.highlight(popup.parts, colour);
                window.getSelection()?.removeAllRanges();
                setPopup(null);
              }}
              onOpenNote={(): void => {
                if (popup.kind === 'highlight') {
                  setPopup({ ...popup, noteOpen: !popup.noteOpen });

                  return;
                }

                // A note needs something to hang on: the words are highlighted first.
                const id = marks.highlight(popup.parts, 'yellow');

                window.getSelection()?.removeAllRanges();
                setPopup(
                  id === null
                    ? null
                    : { kind: 'highlight', id, noteOpen: true, anchor: popup.anchor },
                );
              }}
              onNoteChange={(note): void => {
                if (popup.kind === 'highlight') {
                  marks.setNote(popup.id, note);
                }
              }}
              onRemove={(): void => {
                if (popup.kind === 'highlight') {
                  marks.remove(popup.id);
                }

                setPopup(null);
              }}
              onListen={(): void => {
                const text =
                  popupHighlight?.text ??
                  (popup.kind === 'selection'
                    ? popup.parts.map((part) => part.text).join(' ')
                    : '');

                setVoiceNoticeDismissed(false);
                speak(text);
              }}
              onCopy={(): void => {
                const text =
                  popupHighlight?.text ??
                  (popup.kind === 'selection'
                    ? popup.parts.map((part) => part.text).join(' ')
                    : '');

                void navigator.clipboard.writeText(text).catch(() => undefined);
                setPopup(null);
              }}
              onClose={(): void => {
                setPopup(null);
              }}
            />
          )}
        {ready !== null && printOpen && (
          <PrintDialog
            document={ready.document}
            documentName={ready.name}
            pageCount={pageCount}
            currentPage={currentPage}
            rotation={rotation}
            onClose={(): void => {
              setPrintOpen(false);
            }}
          />
        )}
      </div>
    </main>
  );
};
