# word

Owns the highest-risk product interaction: turning a pointer event on rendered
text into the word the reader meant, then normalising it for lookup.

- Depends on a text-layer abstraction, never on PDF.js directly.
- Any custom geometry logic must be isolated, documented and regression tested
  (AGENTS.md section 9).
- Must not know what happens to the word afterwards.

Introduced by Milestone 1. Empty until then.
