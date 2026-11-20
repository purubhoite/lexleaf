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
- The macOS buttons point at the `mac-test-0.2.9` pre-release, because the Mac build is a
  test build. Update them when a signed Mac release exists.
- Screenshots are in `assets/`: `lookup.png` (the hero), `reading.png` and `settings.png`
  (beside the steps). All three are 1483 × 1012 captures of the whole window, flattened on
  black. Replacing one keeps the same file name, so nothing else needs changing; update
  the `width` and `height` attributes if the size changes.

## Deploying

See [DEPLOYING.md](DEPLOYING.md): Vercel, then the DNS records at GoDaddy, step by step,
including what the records mean and how to check the result.

## Separate repository

The plan is a repository of its own, so the site can be rebuilt without touching the
application's releases. This folder is ready to become one: it is self-contained, and
`git subtree split --prefix=website` produces a branch of just these files.

To move it: create the repository empty (no README, no licence), then

```bash
git subtree split --prefix=website -b site-only   # in a clone of this repository
git push <new repository> site-only:main
```

and point Vercel at the new repository with the Root Directory at its root. Delete this
folder from the application repository once the site is live from its own.
