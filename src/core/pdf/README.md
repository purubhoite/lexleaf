# pdf

Owns everything about getting a PDF onto the screen: opening a document,
rendering a page, and exposing its text layer.

- Port: a document/page interface the reader controller depends on.
- Adapter: PDF.js (ADR-003, provisional until Milestone 1 proves it).
- Must not know about dictionaries, AI, vocabulary or licensing.
- Must surface predictable failures (corrupt, encrypted, no text layer) as
  values, not exceptions.

Introduced by Milestone 1. Empty until then.
