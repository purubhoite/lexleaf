/** @vitest-environment jsdom */
import { joinSegments } from '@core/word/identifyWord';
import { describe, expect, it, vi } from 'vitest';

import { buildChapter, EPUB_TEXT_CLASS } from './chapter';

const xhtml = (body: string): Document =>
  new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>T</title><style>p{color:red}</style><script>window.hacked = true</script></head><body>${body}</body></html>`,
    'application/xml',
  );

const build = async (
  body: string,
  image = vi.fn<(href: string) => Promise<string | null>>(() => Promise.resolve(null)),
) => ({
  ...(await buildChapter(xhtml(body), document, { image })),
  image,
});

describe('making a chapter safe to show', () => {
  it('keeps headings, paragraphs and emphasis', async () => {
    const { root } = await build('<h1>One</h1><p>Some <em>fine</em> words.</p>');

    expect(root.querySelector('h1')?.textContent).toBe('One');
    expect(root.querySelector('p em')?.textContent).toBe('fine');
  });

  it('carries no script, style, frame, form or media over', async () => {
    const { root } = await build(
      '<p>Text</p><script>alert(1)</script><style>*{}</style><iframe src="https://x.example"></iframe>' +
        '<form action="https://x.example"><input value="v"/><button>Go</button></form>' +
        '<object data="x"></object><embed src="x"/><video src="x"></video><audio src="x"></audio>',
    );

    expect(
      root.querySelectorAll(
        'script, style, iframe, form, input, button, object, embed, video, audio',
      ),
    ).toHaveLength(0);
    expect(root.textContent).toBe('Text');
  });

  it('copies no attribute from the book: no handlers, styles, ids, classes or links', async () => {
    const { root } = await build(
      '<p onclick="steal()" style="position:fixed" id="x" class="y">A <a href="https://x.example" onmouseover="steal()">link</a> and <span style="font-size:99px">more</span></p>',
    );

    const attributes = [...root.querySelectorAll('*')].flatMap((element) =>
      element
        .getAttributeNames()
        .filter((name) => !(name === 'class' && element.className === EPUB_TEXT_CLASS)),
    );

    expect(attributes).toStrictEqual([]);
    // The link is not recreated, but its words are kept.
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('A link and more');
  });

  it('keeps the words of an element it does not recreate', async () => {
    const { root } = await build('<p>Before <marquee>moving</marquee> <font>after</font></p>');

    expect(root.querySelector('marquee, font')).toBeNull();
    expect(root.textContent).toBe('Before moving after');
  });

  it('shows a picture only through the book, and only when the book has it', async () => {
    const image = vi.fn((href: string) =>
      Promise.resolve<string | null>(
        href === 'images/cat.png' ? 'data:image/png;base64,AAAA' : null,
      ),
    );
    const { root } = await build(
      '<p><img src="images/cat.png" alt="A cat" onerror="steal()"/><img src="https://x.example/track.gif"/></p>',
      image,
    );
    const pictures = root.querySelectorAll('img');

    expect(pictures).toHaveLength(1);
    expect(pictures[0]?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(pictures[0]?.getAttribute('alt')).toBe('A cat');
    expect(pictures[0]?.getAttributeNames().sort()).toStrictEqual(['alt', 'src']);
    expect(image).toHaveBeenCalledWith('https://x.example/track.gif');
  });

  it('takes the picture out of a drawing that wraps one, and drops the drawing', async () => {
    const image = vi.fn<(href: string) => Promise<string | null>>(() =>
      Promise.resolve('data:image/jpeg;base64,BBBB'),
    );
    const { root } = await build(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script><image xlink:href="cover.jpg"/></svg>',
      image,
    );

    expect(root.querySelector('svg, script')).toBeNull();
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,BBBB');
    expect(image).toHaveBeenCalledWith('cover.jpg');
  });

  it('wraps every run of text, and the runs in order are the chapter text', async () => {
    const { root, segments } = await build(
      '<h1>Title</h1>\n  <p>First <b>bold</b> words.</p>\n<p>Second.</p>',
    );
    const spans = [...root.querySelectorAll(`.${EPUB_TEXT_CLASS}`)];

    expect(spans.map((span) => span.textContent)).toStrictEqual(
      segments.map((segment) => segment.text),
    );
    expect(segments.map((segment) => segment.text)).toStrictEqual([
      'Title',
      'First ',
      'bold',
      ' words.',
      'Second.',
    ]);
  });

  it('ends a line at the end of each block, so words never join across paragraphs', async () => {
    const { segments } = await build('<p>ends here</p><p>starts here</p>');
    const { text } = joinSegments(segments);

    expect(text).toMatch(/ends here\s+starts here/u);
    expect(text).not.toContain('herestarts');
  });

  it('breaks the line at a line break', async () => {
    const { segments } = await build('<p>one<br/>two</p>');

    expect(segments[0]).toStrictEqual({ text: 'one', endsLine: true });
  });

  it('keeps the spacing of preformatted text and tidies the rest', async () => {
    const { segments } = await build('<p>a\n   b</p><pre>x\n  y</pre>');

    expect(segments[0]?.text).toBe('a b');
    expect(segments[1]?.text).toBe('x\n  y');
  });

  it('reads a chapter with no body at all', async () => {
    const source = new DOMParser().parseFromString('<root><p>Loose</p></root>', 'application/xml');
    const { root } = await buildChapter(source, document, { image: () => Promise.resolve(null) });

    expect(root.textContent).toBe('Loose');
  });
});
