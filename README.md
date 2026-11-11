<div align="center">
  <img src="resources/icons/lexleaf-logo.png" alt="Lexleaf logo" width="112" />
  <h1>Lexleaf</h1>
  <p><strong>Read deeper. Stay curious.</strong></p>
  <p>A local-first desktop PDF reader for looking up unfamiliar words without leaving the page.</p>

  <p>
    <a href="https://github.com/purubhoite/lexleaf/stargazers"><img src="https://img.shields.io/github/stars/purubhoite/lexleaf?style=flat&label=stars" alt="GitHub stars" /></a>
    <a href="https://github.com/purubhoite/lexleaf/releases/latest"><img src="https://img.shields.io/github/v/release/purubhoite/lexleaf?style=flat&label=latest%20release" alt="Latest release" /></a>
    <a href="https://github.com/purubhoite/lexleaf/blob/main/LICENSE"><img src="https://img.shields.io/github/license/purubhoite/lexleaf?style=flat" alt="Apache-2.0 license" /></a>
    <a href="https://github.com/purubhoite/lexleaf/actions/workflows/windows-release-verify.yml"><img src="https://github.com/purubhoite/lexleaf/actions/workflows/windows-release-verify.yml/badge.svg?branch=main" alt="Windows verification status" /></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-2f6f4e?style=flat" alt="Windows x64" />
  </p>

  <p>
    <a href="https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/Lexleaf-0.1.0-x64-setup.exe"><strong>Download for Windows</strong></a>
    ·
    <a href="https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/Lexleaf-0.1.0-x86_64.AppImage"><strong>Download for Linux (AppImage)</strong></a>
    ·
    <a href="https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/Lexleaf-0.1.0-amd64.deb"><strong>Download for Debian/Ubuntu</strong></a>
    ·
    <a href="https://github.com/purubhoite/lexleaf/releases/tag/v0.1.0">View release notes and checksums</a>
  </p>
</div>

## What Lexleaf does

Lexleaf keeps the reading loop in one place. Open a PDF, select a word, read its dictionary entry, and save it to a vocabulary library for later review. The bundled Open English WordNet-derived dictionary works offline after installation; no account or document upload is required for the core reading workflow.

The current release is **v0.1.0 for Windows x64**. The installer is unsigned because no code-signing certificate is configured, so Windows SmartScreen may display a warning. Check the release's `SHA256SUMS.txt` before running the installer, and use your normal security judgment rather than blindly bypassing a warning.

## Features in v0.1.0

- PDF reading with local rendering powered by PDF.js.
- Vocabulary-first lookup: double-click a word to open its definition.
- Word navigation with `Alt+Left` and `Alt+Right`, then `Enter` to look up the focused word.
- Save a definition to the local vocabulary library and revisit saved words.
- Search and sort saved vocabulary, with document-aware library context.
- Reading-position and recent-document persistence.
- Zoom controls: `Ctrl/Cmd++`, `Ctrl/Cmd+-`, and `Ctrl/Cmd+0` for fit width.
- In-document search with `Ctrl/Cmd+F`.
- Light, dark, and system appearance preferences, plus reduced-motion support.
- Offline dictionary data packaged separately from the Apache-2.0 application code.

AI explanation code is present for future evaluation and is disabled by default in v0.1.0; it is not required for PDF reading, dictionary lookup, or saved vocabulary.

## Install on Windows

1. Download [Lexleaf-0.1.0-x64-setup.exe](https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/Lexleaf-0.1.0-x64-setup.exe) from the existing [v0.1.0 release](https://github.com/purubhoite/lexleaf/releases/tag/v0.1.0).
2. Download `SHA256SUMS.txt` from the same release and verify the installer before opening it:

   ```powershell
   (Get-FileHash .\Lexleaf-0.1.0-x64-setup.exe -Algorithm SHA256).Hash
   ```

   Compare the result with the `Lexleaf-0.1.0-x64-setup.exe` line in `SHA256SUMS.txt`.

3. Run the installer. It is unsigned; SmartScreen may ask for additional confirmation.
4. Open Lexleaf and choose **Open PDF…** to begin reading.

The published installer is self-contained; end users do not need Node.js or npm.

## Install on Linux

Lexleaf's Linux release targets **x86_64 / amd64** and is distributed as an AppImage and a Debian package. These packages are built from the same v0.1.0 source release as the Windows installer.

- [Download the AppImage](https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/Lexleaf-0.1.0-x86_64.AppImage)
- [Download the Debian package](https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/Lexleaf-0.1.0-amd64.deb)
- [Download SHA256SUMS.txt](https://github.com/purubhoite/lexleaf/releases/download/v0.1.0/SHA256SUMS.txt)
- [Open the v0.1.0 release page](https://github.com/purubhoite/lexleaf/releases/tag/v0.1.0)

### AppImage

Download the AppImage, make it executable, and launch it:

```bash
chmod +x Lexleaf-0.1.0-x86_64.AppImage
./Lexleaf-0.1.0-x86_64.AppImage
```

### Debian and Ubuntu

Install the `.deb` package with `apt`:

```bash
sudo apt install ./Lexleaf-0.1.0-amd64.deb
```

Launch **Lexleaf** from your desktop application menu, or run `lexleaf` from a terminal. Remove it with:

```bash
sudo apt remove lexleaf
```

The packages target amd64/x86_64 Linux. They are not claims of support for every Linux distribution. The AppImage is intended for common x86_64 desktop environments; the Debian package is intended for Debian, Ubuntu, Linux Mint, and compatible distributions. A desktop session and the system libraries required by Electron are still required.

Lexleaf stores its local profile under Electron's per-user data directory (normally `~/.config/Lexleaf` on Linux), including the local vocabulary database and preferences. Do not store user data in the application installation directory.

## How to use it

1. Choose **Open PDF…** and select a PDF.
2. Double-click an unfamiliar word in the document. Lexleaf shows the available dictionary definition in a popup.
3. Choose **Save word** to add it to your vocabulary.
4. Open the vocabulary/library view to search, sort, and revisit saved words. Saved entries remain associated with their source document when that context is available.

### Keyboard shortcuts

| Shortcut                     | Action                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `Ctrl/Cmd +` or `Ctrl/Cmd =` | Zoom in                                                        |
| `Ctrl/Cmd -`                 | Zoom out                                                       |
| `Ctrl/Cmd 0`                 | Fit page to width                                              |
| `Ctrl/Cmd F`                 | Open document search                                           |
| `Alt Left` / `Alt Right`     | Move between words under the pointer/focus                     |
| `Enter`                      | Look up the focused word                                       |
| `Esc`                        | Close the definition popup, then close search/word interaction |

## Local-first architecture and privacy

PDF rendering, dictionary lookup, saved vocabulary, reading position, recent documents, and preferences are implemented locally. The dictionary is read from packaged files, and saved vocabulary is stored in a local SQLite database. Lexleaf does not require an account, subscription, telemetry service, cloud document upload, or cloud vocabulary sync for the core workflow.

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
npm run package:win:poc
```

It prepares the production dictionary, builds the application, creates an unpacked Windows build, verifies its packaged output, and creates an NSIS installer. Windows packaging requires a Windows build environment. The generated dictionary is build output and is intentionally not committed to the source repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and fixture expectations, and [WINDOWS-OFFLINE-VERIFICATION.md](WINDOWS-OFFLINE-VERIFICATION.md) for the Windows verification procedure.

## Dictionary attribution and licensing

Lexleaf application code is licensed under [Apache License 2.0](LICENSE), with project notices in [NOTICE](NOTICE). The bundled dictionary is separate third-party data and is **not** Apache-2.0 application code. It is derived from [Open English WordNet 2024](https://en-word.net/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and incorporates material governed by the Princeton WordNet license. See [`resources/dictionary/NOTICE.md`](resources/dictionary/NOTICE.md) for the generated attribution, source information, modification statement, and disclaimers. Lexleaf is not affiliated with, sponsored by, or endorsed by Princeton University or the Open English WordNet team.

## Contributing and support

- [Report a bug](https://github.com/purubhoite/lexleaf/issues/new?labels=bug)
- [Request a feature](https://github.com/purubhoite/lexleaf/issues/new?labels=enhancement)
- [Browse existing issues](https://github.com/purubhoite/lexleaf/issues)
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- For security concerns, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

Lexleaf application code is available under the Apache-2.0 license. Third-party dictionary data has separate terms and notices described above.
