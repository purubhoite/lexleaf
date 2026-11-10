import type { DictionaryQuery, DictionaryResult } from '@core/dictionary/types';
import { DictionaryArtifactError } from '@core/dictionary/wordnet/binaryIndex';
import {
  openWordNetProvider,
  type DictionaryArtifact,
  type WordNetProvider,
} from '@core/dictionary/wordnet/wordNetFileProvider';

/**
 * The dictionary, as the main process owns it.
 *
 * Responsibilities, and deliberately nothing else: find the artifact, open
 * it once, answer queries, translate every failure into the four-state
 * result model, and shut down cleanly. There is no user interface here, no
 * knowledge of windows or documents, and nothing that reaches the network.
 *
 * Opening is lazy but happens at most once per process. A dictionary that
 * will not open is not retried on every click: the first attempt records
 * why, and every later lookup answers `unavailable` with the same reason,
 * which keeps a broken install from costing a filesystem probe per word.
 */

export interface DictionaryServiceOptions {
  /** Resolves the artifact directory, or `null` when it is not installed. */
  readonly locate: () => string | null;
  /** Opens an artifact directory. Throws `DictionaryArtifactError`. */
  readonly open: (directory: string) => DictionaryArtifact;
  /** Main-process diagnostics. Never crosses the process boundary. */
  readonly onDiagnostic?: (message: string) => void;
  /** Monotonic clock, injected so startup timing can be measured in tests. */
  readonly now?: () => number;
}

export interface DictionaryStatus {
  readonly state: 'ready' | 'unavailable' | 'unopened';
  readonly reason: DictionaryUnavailable['reason'] | null;
  readonly headwords: number | null;
  readonly release: string | null;
  /** Milliseconds the first open took, once it has happened. */
  readonly openMilliseconds: number | null;
}

type DictionaryUnavailable = Extract<DictionaryResult, { status: 'unavailable' }>;

export interface DictionaryService {
  /** Opens the artifact if that has not happened yet. Never throws. */
  prepare(): DictionaryStatus;
  lookUp(query: DictionaryQuery): DictionaryResult;
  status(): DictionaryStatus;
  close(): void;
}

const UNOPENED: DictionaryStatus = {
  state: 'unopened',
  reason: null,
  headwords: null,
  release: null,
  openMilliseconds: null,
};

export const createDictionaryService = ({
  locate,
  open,
  onDiagnostic = (): void => {},
  now = (): number => Date.now(),
}: DictionaryServiceOptions): DictionaryService => {
  let provider: WordNetProvider | null = null;
  let current: DictionaryStatus = UNOPENED;
  let closed = false;

  const prepare = (): DictionaryStatus => {
    if (closed || current.state !== 'unopened') {
      return current;
    }

    const started = now();
    const directory = locate();

    if (directory === null) {
      onDiagnostic('dictionary artifact not found; lookup is unavailable');
      current = { ...UNOPENED, state: 'unavailable', reason: 'not-installed' };

      return current;
    }

    try {
      provider = openWordNetProvider(open(directory), { onDiagnostic });
      current = {
        state: 'ready',
        reason: null,
        headwords: provider.headwordCount,
        release: `${provider.manifest.source.dataset} ${provider.manifest.source.release}`,
        openMilliseconds: now() - started,
      };

      onDiagnostic(
        `dictionary ready: ${String(provider.headwordCount)} headwords in ${String(
          current.openMilliseconds,
        )} ms`,
      );
    } catch (error: unknown) {
      const reason = error instanceof DictionaryArtifactError ? error.reason : 'unreadable';

      // The detail is useful to whoever is debugging an installation and
      // must never reach the renderer, so it is logged here and dropped.
      onDiagnostic(
        `dictionary could not be opened (${reason}): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );

      provider = null;
      current = {
        ...UNOPENED,
        state: 'unavailable',
        reason,
        openMilliseconds: now() - started,
      };
    }

    return current;
  };

  return {
    prepare,
    status: (): DictionaryStatus => current,

    lookUp(query: DictionaryQuery): DictionaryResult {
      const state = prepare();

      if (provider === null || state.state !== 'ready') {
        return { status: 'unavailable', reason: state.reason ?? 'unreadable' };
      }

      return provider.lookUp(query);
    },

    close(): void {
      closed = true;
      provider?.close();
      provider = null;
    },
  };
};
