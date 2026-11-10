# persistence

Owns the reader's place in a document: the recent list, the last document
opened, and per-document reading position and zoom.

- Port: records and migrations expressed in domain terms, with no file,
  process or storage technology named here.
- Adapter: one JSON file written atomically by the main process
  (`src/main/persistence/`), chosen in ADR-016 for a bounded, 20-entry,
  write-often state.
- No UI component may reach a store directly (PRODUCT_SPEC section 10).
- Malformed or outdated stored data is handled deliberately: an unreadable
  file is quarantined and reading continues with empty state.

**Saved words are not here.** ADR-007 originally read as though one SQLite
store would own documents, reading position and saved words alike. ADR-021
supersedes that: vocabulary is relational, user-owned data with a different
lifetime, and it lives in its own SQLite database behind its own port —
`src/core/vocabulary/` for the rules and `src/main/vocabulary/` for the only
SQL in the product. The two stores share no datum; the only thing they have
in common is the content-derived document id, which each derives from the
file's bytes rather than copying from the other
(`docs/ARCHITECTURE.md` section 9).

Introduced by Milestone 2.
