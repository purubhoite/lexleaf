# Lexleaf

Are you tired of heading towards google or a dictionary anytime you encounter a word you don't know?
Lexleaf is a local-first desktop PDF reader with a simple yet helpful feature, you get the meaning of any word you select in an instant, completely offline, and you don't need to ever leave your reading. PDF documents and saved vocabulary stay on the computer; the application does not require an account, subscription, telemetry service or cloud document upload.

## V1 status

Lexleaf V1 is an offline-first reader with local PDF rendering, an OEWN-derived dictionary, contextual word lookup and saved vocabulary. AI-related source remains in the repository for future evaluation, but AI is disabled by default in V1 and is not required for the reader or dictionary workflow.

The first Windows x64 release is distributed through the repository's GitHub Releases page. The installer is unsigned because no code-signing certificate is configured; Windows SmartScreen may warn before installation. Verify the published `SHA256SUMS.txt` before running it.

## Requirements

- Node.js 22.13 or newer (the verification environment uses Node.js 22.21.1).
- npm.
- A desktop environment supported by Electron for interactive launches.

## Development

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run format:check
npm test
npm run test:integration
npm run build
```

## Dictionary setup

Generated dictionary data is intentionally not committed. Build-time acquisition uses the pinned source specification in `scripts/dictionary/source.json`:

```bash
npm run dictionary:fetch
npm run dictionary:build
npm run dictionary:verify
npm run dictionary:verify:production
```

The fetch step downloads the pinned Open English WordNet 2024 inputs outside the repository and verifies their recorded byte counts and SHA-256 digests. The build is deterministic and writes `resources/dictionary/`, which remains generated output.

The application dictionary is derived from Open English WordNet and is separately licensed. See the generated dictionary notice and the source metadata for attribution. Do not treat the dictionary as Apache-2.0 application code.

## Installing a Windows release

Download `Lexleaf-0.1.0-x64-setup.exe` and `SHA256SUMS.txt` from GitHub Releases. On PowerShell, verify the installer with:

```powershell
(Get-FileHash .\Lexleaf-0.1.0-x64-setup.exe -Algorithm SHA256).Hash
```

Compare the result with the installer entry in `SHA256SUMS.txt`. The installer is unsigned; Windows SmartScreen may display a warning. Lexleaf stores documents and vocabulary locally and does not require an account, cloud sync or telemetry.

## Licensing

Lexleaf application code is licensed under the Apache-2.0 license; see `LICENSE` and `NOTICE`. The OEWN-derived dictionary is separate third-party data: Open English WordNet 2024 is licensed under CC BY 4.0 and incorporates material governed by the Princeton WordNet license. The generated dictionary notice preserves both attributions, source information, modification statement and disclaimers. Lexleaf is not affiliated with, sponsored by, or endorsed by Princeton University or the Open English WordNet team.

## Limitations

- Generated dictionary data is not included in this source preview.
- Windows installer, signing and native Windows DPI verification require the appropriate Windows workflow.
- AI is disabled in V1.
- This repository does not claim a published installer or release artifact.

## Contributions and security

See `CONTRIBUTING.md` for development and fixture expectations. See `SECURITY.md` for responsible vulnerability reporting.
