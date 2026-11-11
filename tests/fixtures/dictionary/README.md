# Synthetic dictionary fixture

A complete dictionary artifact, 2.3 KB in total, used by every dictionary
test. **No test needs the real 29 MB release**, and a fresh clone can run the
whole suite offline.

## Provenance and licence

`source.json` is **written for this repository**. Every definition in it was
composed for the test suite; nothing is copied from WordNet, from Webster's,
or from any other dictionary. That is what allows a dictionary fixture to be
committed at all.

The other five files are **generated** from it by the same writer that builds
the shipped artifact:

```bash
npm run dictionary:fixture
```

`src/main/dictionary/fixtureArtifact.test.ts` rebuilds them into a temporary
directory and compares the bytes, so the committed fixture can never drift
from the format the application reads.

## What it exercises

Twenty-nine headwords chosen so that every state of the lookup pipeline has a
test:

| State                                              | Entries                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Plain hit, with example, synonym and pronunciation | `book`, `water`, `lighthouse`                                                                                                 |
| Case suppression                                   | `he` (a gas), `at` (an element), `a` (a unit), `best` (a surname), `us` (a country), `london`                                 |
| Inflection shadowing                               | `running`, `stopped`, `streaming` beside `run`, `stop`, `stream`                                                              |
| Morphology                                         | `mouse`, `goose`, `child`, `happy`, `carry`, `dog` with the shipped exception table                                           |
| Typographic forms                                  | `e.g.`, `etc.`, `co-operate` and `cooperate`, the contraction hosts `do`, `will`                                              |
| A malformed record                                 | `brokenentry` — an unknown part of speech and an empty definition, which the provider must treat as absent rather than render |
| A miss                                             | anything else, e.g. `zzzznotaword`                                                                                            |

The real artifact is covered separately by
`tests/integration/dictionaryArtifact.test.ts`, which skips itself when
`resources/dictionary/` has not been built.
