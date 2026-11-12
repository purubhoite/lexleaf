<div align="center">
  <img src="resources/icons/lexleaf-logo.png" alt="Lexleaf logo" width="112" />
  <h1>Lexleaf</h1>
  <p><strong>Read deeper. Stay curious.</strong></p>
  <p>A local-first desktop PDF reader for looking up unfamiliar words without leaving the page.</p>

  <p>
    <a href="https://github.com/purubhoite/lexleaf/stargazers"><img src="https://img.shields.io/github/stars/purubhoite/lexleaf?style=flat&label=stars" alt="GitHub stars" /></a>
    <a href="https://github.com/purubhoite/lexleaf/releases/latest"><img src="https://img.shields.io/github/v/release/purubhoite/lexleaf?style=flat&label=latest%20release" alt="Latest release" /></a>
    <a href="https://github.com/purubhoite/lexleaf/releases"><img src="https://img.shields.io/github/downloads/purubhoite/lexleaf/total?style=flat&label=downloads" alt="Total GitHub release asset downloads" /></a>
    <a href="https://github.com/purubhoite/lexleaf/blob/main/LICENSE"><img src="https://img.shields.io/github/license/purubhoite/lexleaf?style=flat" alt="Apache-2.0 license" /></a>
  </p>

  <p>
    <a href="https://github.com/purubhoite/lexleaf/releases/latest"><strong>Download the latest version</strong></a>
    <br />
    Windows installer · Linux AppImage · Debian/Ubuntu package · release notes and checksums
  </p>
</div>

## What Lexleaf does

Lexleaf keeps the reading loop in one place. Open a PDF, select a word, read its dictionary entry, and save it to a vocabulary library for later review. The bundled Open English WordNet-derived dictionary works offline after installation; no account or document upload is required for the core reading workflow.

Lexleaf is released for **Windows x64 and Linux x86_64**. The [latest release](https://github.com/purubhoite/lexleaf/releases/latest) always has the newest version of every download. The installer is unsigned because no code-signing certificate is configured, so Windows SmartScreen may display a warning. Check the release's `SHA256SUMS.txt` before running the installer, and use your normal security judgment rather than blindly bypassing a warning.

## Features

- PDF reading with local rendering powered by PDF.js.
- Open a PDF the way you open any file: double-click it or use **Open with** once Lexleaf is installed, or drag it onto the Lexleaf window.
- Table of contents: for a book that has one, **Contents** opens its chapters beside the pages and shows where you are.
- Vocabulary-first lookup: double-click a word to open its definition.
- Word navigation with `Alt+Left` and `Alt+Right`, then `Enter` to look up the focused word.
- Save a definition to the local vocabulary library and revisit saved words.
- Search and sort saved vocabulary, with document-aware library context.
- Export saved words as a spreadsheet (CSV) or as an Anki import file.
- Reading-position and recent-document persistence.
- Zoom by pinching on a trackpad or with `Ctrl` + mouse wheel, to any size; or step with `Ctrl/Cmd++`, `Ctrl/Cmd+-`, and `Ctrl/Cmd+0` for fit width.
- In-document search with `Ctrl/Cmd+F`.
- Highlights in four colours, each with an optional note: select text and choose a colour. They are listed in the sidebar and can be exported as a Markdown file. They are kept by Lexleaf on your computer; the PDF itself is never changed.
- Bookmarks (`Ctrl/Cmd+D`), and a Back button that returns to where you were after jumping to a chapter, bookmark, note or page.
- A sidebar with Contents, page thumbnails, Bookmarks and Notes.
- Scrolling, one-page and two-page views, and page rotation (remembered per document).
- Printing, of the whole document, the current page or a page range.
- Read aloud for a word or a selection, using a voice installed on your computer; nothing is sent over the network. On Linux this needs `speech-dispatcher` and a voice such as `espeak-ng`.
- Light, dark, and system appearance preferences, plus reduced-motion support.
- Updates on request: Lexleaf tells you when a newer version has been released and, when you ask, downloads and installs it. The check can be turned off in Settings.
- Offline dictionary data packaged separately from the Apache-2.0 application code.

AI explanation code is present for future evaluation and is disabled by default; it is not required for PDF reading, dictionary lookup, or saved vocabulary.

## Install on Windows

1. Open the [latest release](https://github.com/purubhoite/lexleaf/releases/latest) and download the file ending in `-x64-setup.exe`, for example `Lexleaf-1.2.3-x64-setup.exe`.
2. Download `SHA256SUMS.txt` from the same release and verify the installer before opening it:

   ```powershell
   (Get-FileHash .\Lexleaf-*-x64-setup.exe -Algorithm SHA256).Hash
   ```

   Compare the result with the line for that file in `SHA256SUMS.txt`.

3. Run the installer. It is unsigned; SmartScreen may ask for additional confirmation.
4. Open Lexleaf and choose **Open PDF…** to begin reading.

The published installer is self-contained; end users do not need Node.js or npm.

To uninstall, open **Settings → Apps → Installed apps**, find **Lexleaf**, and choose **Uninstall**. Your saved vocabulary and preferences are kept in your user profile (`%APPDATA%\Lexleaf`) and are not removed with the application; delete that folder if you want them gone too.

## Install on Linux

Lexleaf's Linux release targets **x86_64 / amd64** and is distributed as an AppImage and a Debian package. Each release's packages are built from the same source as its Windows installer.

Open the [latest release](https://github.com/purubhoite/lexleaf/releases/latest) and download:

- the AppImage: the file ending in `-x86_64.AppImage`, or
- the Debian package: the file ending in `-amd64.deb`, and
- [SHA256SUMS.txt](https://github.com/purubhoite/lexleaf/releases/latest/download/SHA256SUMS.txt), to verify the download.

The commands below match whichever version you downloaded, as long as only one is in the folder.

### AppImage

Download the AppImage, make it executable, and launch it:

```bash
chmod +x Lexleaf-*-x86_64.AppImage
./Lexleaf-*-x86_64.AppImage
```

### Debian and Ubuntu

Install the `.deb` package with `apt`:

```bash
sudo apt install ./Lexleaf-*-amd64.deb
```

Launch **Lexleaf** from your desktop application menu, or run `lexleaf` from a terminal. Remove it with:

```bash
sudo apt remove lexleaf
```

Versions up to 0.2.1 were packaged under the name `intelligent-pdf-reader`; remove those with `sudo apt remove intelligent-pdf-reader`. Installing a newer package replaces the old one by itself.

The packages target amd64/x86_64 Linux. They are not claims of support for every Linux distribution. The AppImage is intended for common x86_64 desktop environments; the Debian package is intended for Debian, Ubuntu, Linux Mint, and compatible distributions. A desktop session and the system libraries required by Electron are still required.

Lexleaf stores its local profile under Electron's per-user data directory (normally `~/.config/Lexleaf` on Linux), including the local vocabulary database and preferences. Do not store user data in the application installation directory.

### Known issue on Ubuntu: runaway process filling the system log

In version 0.2.0 and earlier, a Lexleaf helper process can be left running with nothing behind it. It then uses a full processor core and writes the same line to `/var/log/syslog` until the disk is full:

```
Error reading message from browser: Socket operation on non-socket (88)
```

This is a defect in Chromium, which Lexleaf is built on, and it has affected other applications built the same way. It usually starts when Ubuntu's "application has stopped unexpectedly" window relaunches a crashed helper process. If you see it, close Lexleaf, then stop the process and empty the log:

```sh
pkill -KILL -f 'lexleaf --type=zygote'
sudo truncate -s 0 /var/log/syslog
```

Later versions stop such a process themselves, and the Debian package tells Ubuntu's crash reporter not to relaunch Lexleaf. Windows is not affected.

The crash that started it, where it has been traced, was in the Nouveau graphics driver (the community driver for NVIDIA cards). From version 0.2.3, Lexleaf does not use the graphics card on a machine running Nouveau, which avoids that crash; reading is unaffected. On any version you can get the same effect by starting Lexleaf with `lexleaf --disable-gpu`. To overrule Lexleaf's choice, set `LEXLEAF_GPU=on` or `LEXLEAF_GPU=off` before starting it.

## How to use it

1. Choose **Open PDF…** and select a PDF, drag a PDF onto the window, or right-click a PDF in your file manager and choose **Open with › Lexleaf**. In a long book, **Contents** lists the chapters.
2. Double-click an unfamiliar word in the document. Lexleaf shows the available dictionary definition in a popup.
3. Choose **Save word** to add it to your saved words. The popup then says the word is saved; **Remove from saved words** is a separate button, so a second click never throws a word away.
4. Choose **Saved words** to search, sort, and revisit them. The list opens beside the page, so the book stays in view, and **Show in book** takes you to the place a word came from.
5. To take your words elsewhere, use **Export all** in Saved words (or **File › Export saved words**): **Spreadsheet (CSV)** opens in Excel, LibreOffice or Google Sheets; **Anki flashcards** writes a text file you bring in with **File › Import** in Anki (word on the front; definition, the sentence you met it in, and the source on the back fields).

**Reading comfortably.** **Reading mode** (`F11`) fills the screen with the page and puts everything else away; `Esc` brings it back. Under **Settings › Page colour** the pages themselves can be shown in sepia, dimmed, or as pale text on a dark page for reading at night. Only how the page looks in Lexleaf changes; the file is never altered. The start screen lists your recent books with how far through each you are and how many words you have saved from it.

**Scanned books.** A scanned PDF is a set of pictures of pages, so there are no words for Lexleaf to look up or search; Lexleaf says so when you open one, and you can still read it. To make lookup work, add a text layer to the file with an OCR tool such as [OCRmyPDF](https://ocrmypdf.readthedocs.io/) (`ocrmypdf scanned.pdf readable.pdf`), then open the new file.

### Keyboard shortcuts

| Shortcut                     | Action                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `Ctrl/Cmd +` or `Ctrl/Cmd =` | Zoom in                                                        |
| `Ctrl/Cmd -`                 | Zoom out                                                       |
| `Ctrl/Cmd 0`                 | Fit page to width                                              |
| Pinch, or `Ctrl` + wheel     | Zoom in and out smoothly                                       |
| `Ctrl/Cmd F`                 | Open document search                                           |
| `Ctrl/Cmd O`                 | Open a PDF                                                     |
| `Ctrl/Cmd W`                 | Close the document                                             |
| `Ctrl/Cmd G`                 | Go to page                                                     |
| `Ctrl/Cmd Shift O`           | Show or hide Contents                                          |
| `Ctrl/Cmd B`                 | Show or hide Bookmarks                                         |
| `Ctrl/Cmd D`                 | Bookmark the current page, or remove its bookmark              |
| `Ctrl/Cmd [`                 | Back to where you were before a jump                           |
| `Ctrl/Cmd P`                 | Print                                                          |
| `Ctrl/Cmd Shift R`           | Rotate pages                                                   |
| `Ctrl/Cmd Shift U`           | Read the selection aloud                                       |
| `Ctrl/Cmd L`                 | Show or hide Saved words                                       |
| `Ctrl/Cmd ,`                 | Show or hide Settings                                          |
| `F11`                        | Reading mode (full screen); `Esc` leaves it                    |
| `Alt Left` / `Alt Right`     | Move between words under the pointer/focus                     |
| `Enter`                      | Look up the focused word                                       |
| `Esc`                        | Close the definition popup, then close search/word interaction |

## Local-first architecture and privacy

PDF rendering, dictionary lookup, saved vocabulary, reading position, recent documents, and preferences are implemented locally. The dictionary is read from packaged files, and saved vocabulary is stored in a local SQLite database. Lexleaf does not require an account, subscription, telemetry service, cloud document upload, or cloud vocabulary sync for the core workflow.

### Update check

Lexleaf checks whether a newer version has been released so that fixes reach you. When it starts, and at most once a day, it requests the public record of the latest Lexleaf release from GitHub (`api.github.com`) and compares the version number with its own. If a newer version exists it shows a notice.

- Nothing is downloaded or installed until you ask. Updating takes two steps, and each waits for you: **Download update** fetches the new version from the Lexleaf release on GitHub while you keep reading, and **Restart and install** closes Lexleaf, installs it, and opens Lexleaf again. You can leave either step for later.
- Updating from inside Lexleaf works for the Windows installer and the Linux AppImage. The Debian package, and any other build, gets a button that opens the release page in your browser instead.
- The download is checked against the SHA-512 published in the release before it is installed. Release binaries are unsigned, so this confirms that the file is the one published on the Lexleaf release page; it is not a publisher signature.
- The requests contain no account, identifier, document, or vocabulary data. As with any web request, GitHub can see the IP address they come from and the application's user-agent string.
- You can turn the automatic check off under **Settings → Updates**. With it off, Lexleaf contacts nothing unless you press **Check for updates now**.
- Versions 0.1.0 and 0.1.1 do not have this check and must be updated by hand from the [releases page](https://github.com/purubhoite/lexleaf/releases/latest).

Optional AI explanation functionality is disabled by default and has separate configuration and network-policy code. Do not interpret the local-first design as a claim that every optional feature or dependency can never make a network request; review and configure optional providers deliberately.

## Development

Requirements: Node.js **22.13.0 or newer** and npm. The Windows verification environment uses Node.js 22.21.1.

```bash
git clone https://github.com/purubhoite/lexleaf.git
cd lexleaf
npm ci
npm run dev
```

Useful checks and builds:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run build
npm run verify
```

To prepare the production dictionary and verify its reproducibility:

```bash
npm run dictionary:prepare:production
npm run dictionary:verify:production
npm run verify:license-compliance
```

The Windows packaging script is:

```bash
npm run package:win
```

It prepares the production dictionary, builds the application, creates an unpacked Windows build, verifies its packaged output, and creates an NSIS installer. Windows packaging requires a Windows build environment. The generated dictionary is build output and is intentionally not committed to the source repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and fixture expectations, and [WINDOWS-OFFLINE-VERIFICATION.md](WINDOWS-OFFLINE-VERIFICATION.md) for the Windows verification procedure.

## Dictionary attribution and licensing

Lexleaf application code is licensed under [Apache License 2.0](LICENSE), with project notices in [NOTICE](NOTICE). The bundled dictionary is separate third-party data and is **not** Apache-2.0 application code. It is derived from [Open English WordNet 2024](https://en-word.net/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and incorporates material governed by the Princeton WordNet license. See [`resources/dictionary/NOTICE.md`](resources/dictionary/NOTICE.md) for the generated attribution, source information, modification statement, and disclaimers. Lexleaf is not affiliated with, sponsored by, or endorsed by Princeton University or the Open English WordNet team.

## Code signing policy

Lexleaf release binaries are **currently unsigned**. Every release publishes `SHA256SUMS.txt` so that a download can be verified against it.

Releases are built from this repository by GitHub Actions on GitHub-hosted runners, from a commit on `main` that has passed the verification workflow. Nothing is built or uploaded from a developer machine.

Team roles:

- Authors and reviewers: [@purubhoite](https://github.com/purubhoite), the repository owner. Changes from anyone else arrive as pull requests and are reviewed by the owner before merging.
- Approvers: [@purubhoite](https://github.com/purubhoite). Every release is started and approved manually by the owner.

Privacy policy: this program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it, with one exception: the [update check](#update-check), which asks GitHub for the latest release version, sends nothing about the user, and can be turned off in Settings. See [Local-first architecture and privacy](#local-first-architecture-and-privacy).

## Contributing and support

- In the app: **Settings › Report a problem** opens a new issue in your browser with your Lexleaf version, operating system and (on Linux) graphics driver already filled in. Lexleaf sends nothing itself; you read the report and choose whether to submit it.
- [Report a bug](https://github.com/purubhoite/lexleaf/issues/new?labels=bug)
- [Request a feature](https://github.com/purubhoite/lexleaf/issues/new?labels=enhancement)
- [Browse existing issues](https://github.com/purubhoite/lexleaf/issues)
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- For security concerns, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

Lexleaf application code is available under the Apache-2.0 license. Third-party dictionary data has separate terms and notices described above.
