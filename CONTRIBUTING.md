# Contributing

## Development setup

Use Node.js 22.13 or newer, then install dependencies without committing generated output:

```bash
npm ci
```

Run the application with `npm run dev`.

## Verification

Before proposing a change, run the checks relevant to the change:

```bash
npm run typecheck
npm run format:check
npm test
npm run test:integration
npm run build
```

Dictionary changes also require the pinned-source and reproducibility checks documented in `scripts/dictionary/README.md`. Generated dictionary data under `resources/dictionary/` is not committed.

## Fixtures and test data

Use synthetic fixtures or material with clear redistribution permission. Do not add personal PDFs, user databases, screenshots containing private documents, credentials or machine-specific logs. New PDF fixtures should document their purpose and provenance in the fixture documentation.

## Licensing

Application code is Apache-2.0. Third-party datasets, notices, fonts, icons and other assets may have separate terms. In particular, the OEWN-derived dictionary and Princeton WordNet material must retain their own attribution and licensing boundary.

## Product policy

Lexleaf V1 is local-first. Do not add telemetry, cloud document upload, authentication, payments, subscriptions or automatic updates without an explicit product decision. AI remains disabled by default in V1.

One exception has been decided: updates on request. Lexleaf may ask GitHub for the latest release version, at most once a day, and tell the reader when a newer one exists. The check is on by default, can be turned off in Settings, and sends nothing about the reader. Finding a release never downloads it and downloading it never installs it: each step runs only when the reader presses its button (`src/main/update/updateInstaller.ts` switches off everything `electron-updater` would do by itself). The two destinations are fixed: the constant in `src/main/update/updateService.ts` and the `publish` entry in the builder configurations. Do not make them configurable, add other destinations, accept a version or address from the renderer, or make any step automatic without a new product decision. `electron-updater` must stay bundled into the main process (`electron.vite.config.ts`), because the packaged application ships no `node_modules`.
