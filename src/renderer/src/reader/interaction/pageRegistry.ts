import type { TextLayerIndex } from '../pdf/textLayerIndex';

/**
 * Which pages are rendered right now, and what each of them contains.
 *
 * With one page on screen (Milestone 1) "the text layer" was unambiguous.
 * With several pages alive at once it is not, and the danger is specific: a
 * click on page 7 resolving against the text of page 6 would produce a
 * confident, wrong word. The registry removes the ambiguity by making every
 * live page carry its own identity — document, page number and render
 * generation — and by resolving interactions **from the element under the
 * pointer upwards**, never from "the current page" (ADR-018).
 *
 * A page is registered only when its render has completed, and released when
 * it is recycled, so an entry always describes a layer that is on screen.
 */

export interface LivePage {
  readonly documentId: string;
  readonly pageNumber: number;
  /** The render attempt this layer came from. */
  readonly generation: number;
  readonly scale: number;
  /** Element carrying `data-page-number`; contains the canvas and text layer. */
  readonly container: HTMLElement;
  readonly layer: TextLayerIndex;
}

export interface PageRegistry {
  register(page: LivePage): void;
  /** Removes the entry only if it is still the one that was registered. */
  release(pageNumber: number, generation: number): void;
  get(pageNumber: number): LivePage | null;
  /** Finds the page that owns a DOM node, by walking up from it. */
  pageOfNode(node: Node | null): LivePage | null;
  livePages(): readonly LivePage[];
  /** Increments whenever the set of live pages changes. */
  version(): number;
  subscribe(listener: () => void): () => void;
}

export const PAGE_NUMBER_ATTRIBUTE = 'data-page-number';

let generationCounter = 0;

/**
 * A process-wide monotonic counter.
 *
 * Monotonic rather than per page, so that a generation value is unique
 * across pages, documents and remounts: comparing two of them can never be
 * accidentally true.
 */
export const nextRenderGeneration = (): number => {
  generationCounter += 1;

  return generationCounter;
};

const elementOf = (node: Node | null): Element | null => {
  if (node === null) {
    return null;
  }

  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
};

export const createPageRegistry = (): PageRegistry => {
  const pages = new Map<number, LivePage>();
  const listeners = new Set<() => void>();
  let version = 0;

  const changed = (): void => {
    version += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    register(page: LivePage): void {
      pages.set(page.pageNumber, page);
      changed();
    },

    release(pageNumber: number, generation: number): void {
      const current = pages.get(pageNumber);

      // A page that has already been re-registered by a newer render must
      // not be removed by the cleanup of the older one.
      if (current !== undefined && current.generation === generation) {
        pages.delete(pageNumber);
        changed();
      }
    },

    get: (pageNumber: number): LivePage | null => pages.get(pageNumber) ?? null,

    pageOfNode(node: Node | null): LivePage | null {
      const element = elementOf(node);
      const host = element?.closest(`[${PAGE_NUMBER_ATTRIBUTE}]`) ?? null;

      if (host === null) {
        return null;
      }

      const pageNumber = Number(host.getAttribute(PAGE_NUMBER_ATTRIBUTE));
      const page = pages.get(pageNumber) ?? null;

      // The element must belong to the layer that is registered, not merely
      // to a container with the same number from a previous render.
      return page !== null && page.container === host ? page : null;
    },

    livePages: (): readonly LivePage[] =>
      [...pages.values()].sort((left, right) => left.pageNumber - right.pageNumber),

    version: (): number => version,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      return (): void => {
        listeners.delete(listener);
      };
    },
  };
};
