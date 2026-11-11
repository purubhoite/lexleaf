# The dictionary build pipeline

Turns a pinned Open English WordNet release into the artifact the application
reads. Nothing here runs at application runtime, and nothing here is bundled:
these scripts are plain ESM on Node's standard library, and the data they
produce is deliberately **not** committed.

```bash
npm run dictionary:fetch     # download the pinned release and verify its SHA-256
npm run dictionary:build     # transform it into resources/dictionary/
npm run dictionary:verify    # build twice and prove the bytes are identical
npm run dictionary:fixture   # rebuild the committed synthetic test fixture
```

## The stages

| Stage     | File                                                      | What it guarantees                                                                                                                                                                    |
| --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin       | `source.json`                                             | The release URL, its byte count and its SHA-256, plus the transform version. Changing the data means editing this file and re-recording the digest.                                   |
| Fetch     | `fetch-source.mjs`                                        | Downloads into a cache **outside** the repository, verifies the digest and **fails closed** on a mismatch. A cached file is re-verified, never trusted.                               |
| Read      | `lib/unzip.mjs`, `lib/wndb.mjs`, `lib/pronunciations.mjs` | Decompresses the archive and parses the WNDB data files and the LMF XML with no third-party parser.                                                                                   |
| Transform | `build.mjs`                                               | Selects headwords and senses, trims to the documented limits, and extracts the licence header verbatim from the release's own `data.noun`. Definition wording is never altered.       |
| Write     | `lib/artifact.mjs`                                        | Writes `entries.jsonl`, `entries.idx`, `morphology.json`, `manifest.json` and `NOTICE.md`. Keys sorted by UTF-8 byte order, fixed field order, no clock, no locale, no absolute path. |
| Verify    | `verify-reproducible.mjs`                                 | Builds into two temporary directories and compares digests.                                                                                                                           |

## Determinism

The artifact must rebuild byte-for-byte from the same source, because that is
what makes the recorded SHA-256 digests meaningful. Nothing in these scripts
may read the clock, the locale, the filesystem's directory order, an
environment variable or a machine path into the output. `entries.idx` is the
format described in `src/core/dictionary/wordnet/binaryIndex.ts`; this is the
only writer of it, and the reader lives in `src/core`, with no import
crossing between them.

## Licensing

`NOTICE.md` is generated from `manifest.json`, so the notice and the
checksums cannot drift apart. It carries the full Princeton WordNet licence
text — extracted from the release's own data files rather than retyped — the
CC BY 4.0 statement and URL, credit to Princeton University and the Open
English WordNet team, the modification statement, the pinned source URLs with
their digests and a digest per generated file. It also states that **no legal
review of this redistribution has been carried out**. Do not remove that
sentence, and do not use Princeton's or the University's name in marketing
copy.
