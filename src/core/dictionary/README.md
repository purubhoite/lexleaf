# dictionary

Owns offline definition lookup.

- Port: `DictionaryQuery -> DictionaryResult`, with four explicit states —
  found, found with genuinely absent optional fields, not found, and
  unavailable. No fabricated fields, and no provider error text, `errno` or
  path crosses the boundary.
- The query carries `IdentifiedWord.normalized` verbatim, plus `raw` and
  `joinedAcrossLines`. Alternative lookup **keys** (restored trailing period,
  hyphen variants, split contractions, morphological base forms) are derived
  here; `src/core/word/normalizeWord.ts` is not re-implemented and not
  modified.
- Lookup is one deterministic ordered pipeline: exact → case → typographic →
  morphology → miss. It must work offline and must never call an AI provider
  (AGENTS.md section 10).
- Adapter: a bundled local dataset behind the port. Open English WordNet 2024
  as an indexed payload file (ADR-019, superseding the "WordNet initially"
  sketch in ADR-004 and PRODUCT_SPEC section 9.1).
- Must not know how PDFs are rendered.

Built in Milestone 3. The architecture was decided in advance (ADR-019,
`docs/DICTIONARY_INVESTIGATION.md`); ADR-020 records what the implementation
measured and the rules it had to invent.

## What is here

| File | Responsibility |
| ---- | -------------- |
| `types.ts` | The port: query, result, sense, pronunciation, attribution, stored record shapes. |
| `candidates.ts` | Turns one query into the ordered candidate keys: exact → case → typographic → morphology. Nothing else decides lookup order. |
| `morphology.ts` | Morphy: the exception tables shipped with the release plus explicit suffix rules. No stemmer, no statistics. |
| `closedClass.ts` | **Application-authored** definitions for grammar words. Not WordNet material; every sense is tagged `source: 'application'`. |
| `senseSelection.ts` | Deterministic case suppression, so `he` is not helium and `best` is not a surname. |
| `lookupPipeline.ts` | Runs the candidates against a store, applies suppression, part-of-speech preference and inflection shadowing, and builds the result. |
| `manifest.ts` | Parses and validates the artifact manifest; derives the attribution shown in the popup. |
| `wordnet/binaryIndex.ts` | The `IPRD` v1 index reader: validation, bounds checks, binary search. Refuses a file it cannot trust. |
| `wordnet/wordNetFileProvider.ts` | Opens an artifact, parses records on demand behind a small LRU, and turns every failure into `unavailable`. |

Two rules in here exist because the data alone answers badly, and both are
stated rather than learned: grammar words come from the closed-class layer
instead of a lexicon of content words, and an entry reached only by a
morphological rule shows the senses of the part of speech that rule assumed
first — the rule that turns `watched` into `watch` is a verb rule, so the
verb senses lead. ADR-020 records both.

The *writer* of the artifact lives in `scripts/dictionary/`, not here: this
folder only reads. Nothing here imports `node:*`, so the same code is
typechecked by both the Node and the web project.
