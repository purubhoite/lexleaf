# Lexleaf website

The product site for Lexleaf, served at [lexleaf.in](https://lexleaf.in).

This folder is a self-contained static site: plain HTML and CSS, no build step, no
dependencies, no framework. `index.html` opens in a browser as it is.

## Files

| File                        | What it is                                                         |
| --------------------------- | ------------------------------------------------------------------ |
| `index.html`                | The whole page, including the download script and structured data. |
| `style.css`                 | The styles, following the application's own colours and type.      |
| `assets/`                   | Logo, favicons, the two screenshots and the social card.           |
| `vercel.json`               | Security headers and asset caching for Vercel.                     |
| `robots.txt`, `sitemap.xml` | For search engines.                                                |

## Editing

- Download buttons point at the latest GitHub release, and the main button names the
  visitor's system. With JavaScript on, the page asks GitHub for the newest release once,
  and points each button at the exact file (`-x64-setup.exe`, `-x86_64.AppImage`,
  `-amd64.deb`) and shows the version number. With it off, every button still reaches the
  release page.
- The macOS buttons point at the `mac-test-0.2.8` pre-release, because the Mac build is a
  test build. Update them when a signed Mac release exists.
- Screenshots are in `assets/`: `lookup.png` (the hero), `reading.png` and `settings.png`
  (beside the steps). All three are 1483 × 1012 captures of the whole window, flattened on
  black. Replacing one keeps the same file name, so nothing else needs changing; update
  the `width` and `height` attributes if the size changes.

## Deploying

Hosted on Vercel, connected to this repository, with **Root Directory** set to `website`
and Framework Preset set to **Other** (no build command; the output is this folder as it
is). A push to `main` deploys to production; a pull request gets its own preview address.

Domain: `lexleaf.in`, with `www.lexleaf.in` redirecting to it. In Vercel, under
**Settings › Domains**, add both. Then, at the domain registrar, set the records Vercel
shows: an `A` record for `@` pointing at Vercel's address, and a `CNAME` record for `www`.
The nameservers may also be pointed at Vercel instead, which handles both at once.

## Separate repository

A new repository was the first plan, but this GitHub connection may push to existing
repositories and may not create new ones, so the site lives in this repository instead.
To move it later: copy this folder into a new repository, point Vercel's Root Directory at
its root, and delete the folder here.
