import type { TextSegment } from '@core/word/types';

/**
 * Turning one chapter of a book into something safe to show.
 *
 * A chapter is a web page written by a stranger. Nothing of it is put on
 * screen as it stands. Instead a new, plain tree is built from scratch:
 * only the kinds of element on a short list are recreated, none of their
 * attributes are copied, and everything else — scripts, styles, forms,
 * frames, links to anywhere — is simply not carried over. What survives is
 * headings, paragraphs, emphasis, lists, quotations, simple tables and
 * pictures that are inside the book itself.
 *
 * Every run of text is wrapped in a span of its own. Those spans, in
 * order, are the chapter's text for looking words up, searching and
 * highlighting — the same job the text layer does for a PDF page.
 */

export const EPUB_TEXT_CLASS = 'epub__text';

/** Elements recreated as themselves. The value says whether each is a block. */
const ALLOWED: Readonly<Record<string, 'block' | 'inline'>> = {
  p: 'block',
  h1: 'block',
  h2: 'block',
  h3: 'block',
  h4: 'block',
  h5: 'block',
  h6: 'block',
  blockquote: 'block',
  pre: 'block',
  ul: 'block',
  ol: 'block',
  li: 'block',
  dl: 'block',
  dt: 'block',
  dd: 'block',
  hr: 'block',
  table: 'block',
  thead: 'block',
  tbody: 'block',
  tfoot: 'block',
  tr: 'block',
  td: 'block',
  th: 'block',
  caption: 'block',
  figure: 'block',
  figcaption: 'block',
  div: 'block',
  section: 'block',
  article: 'block',
  aside: 'block',
  header: 'block',
  footer: 'block',
  em: 'inline',
  i: 'inline',
  strong: 'inline',
  b: 'inline',
  u: 'inline',
  s: 'inline',
  sub: 'inline',
  sup: 'inline',
  small: 'inline',
  code: 'inline',
  cite: 'inline',
  q: 'inline',
  abbr: 'inline',
  span: 'inline',
};

/** Elements left out entirely, with everything inside them. */
const DROPPED = new Set([
  'script',
  'style',
  'head',
  'title',
  'link',
  'meta',
  'base',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'template',
  'noscript',
]);

/** Blocks inside which white space between children means nothing. */
const CONTAINERS = new Set([
  'body',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'ul',
  'ol',
  'dl',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'figure',
  'blockquote',
]);

export interface BuiltChapter {
  /** The safe tree. It is cloned each time the chapter is shown. */
  readonly root: HTMLElement;
  /** The chapter's text, one segment to each text span, in order. */
  readonly segments: readonly TextSegment[];
}

export interface ChapterSources {
  /** The data address of a picture inside the book, or `null` to leave it out. */
  readonly image: (href: string) => Promise<string | null>;
}

const localName = (element: Element): string => element.localName.toLowerCase();

const imageHref = (element: Element): string | null =>
  element.getAttribute('src') ??
  element.getAttribute('href') ??
  element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
  element.getAttribute('xlink:href');

export const buildChapter = async (
  source: Document,
  target: Document,
  sources: ChapterSources,
): Promise<BuiltChapter> => {
  const root = target.createElement('div');
  const segments: TextSegment[] = [];

  /** The last text of a block ends a line, so words never run across blocks. */
  const endLine = (): void => {
    const last = segments.pop();

    if (last !== undefined) {
      segments.push({ text: last.text, endsLine: true });
    }
  };

  const addText = (parent: HTMLElement, text: string): void => {
    const span = target.createElement('span');

    span.className = EPUB_TEXT_CLASS;
    span.textContent = text;
    parent.append(span);
    segments.push({ text, endsLine: false });
  };

  const addImage = async (parent: HTMLElement, element: Element): Promise<void> => {
    const href = imageHref(element);
    const address = href === null ? null : await sources.image(href);

    if (address === null) {
      return;
    }

    const image = target.createElement('img');

    image.src = address;
    image.alt = (element.getAttribute('alt') ?? '').slice(0, 500);
    parent.append(image);
  };

  const visit = async (from: Node, into: HTMLElement, preformatted: boolean): Promise<void> => {
    const container =
      from.nodeType === Node.ELEMENT_NODE && CONTAINERS.has(localName(from as Element));

    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const raw = child.nodeValue ?? '';
        const text = preformatted ? raw : raw.replace(/\s+/gu, ' ');

        // White space between blocks is layout in the source, not text.
        if (text.length === 0 || (text.trim().length === 0 && (container || preformatted))) {
          continue;
        }

        addText(into, text);
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const element = child as Element;
      const name = localName(element);

      if (DROPPED.has(name)) {
        continue;
      }

      if (name === 'br') {
        into.append(target.createElement('br'));
        endLine();
        continue;
      }

      if (name === 'img' || name === 'image') {
        await addImage(into, element);
        continue;
      }

      const kind = ALLOWED[name];

      if (kind === undefined) {
        // Not on the list: the element is not recreated, but its words are kept.
        await visit(element, into, preformatted);
        continue;
      }

      const made = target.createElement(name);

      into.append(made);
      await visit(element, made, preformatted || name === 'pre');

      if (kind === 'block') {
        endLine();
      }
    }
  };

  const body = source.querySelector('body') ?? source.documentElement;

  await visit(body, root, false);

  return { root, segments };
};
