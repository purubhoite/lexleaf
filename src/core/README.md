# Core subsystems

This directory holds the application's domain subsystems. It is **empty by
design** at Milestone 0: the folders below record the boundaries that later
milestones must respect, not placeholder implementations.

Rules for everything placed here:

- a subsystem owns its own types and exposes an explicit interface (a port);
- a subsystem must not import from `main/`, `preload/` or `renderer/`;
- a subsystem must not import Electron, React or another subsystem's internals;
- infrastructure (PDF.js, SQLite, HTTP clients, model vendors) lives in an
  adapter behind the port, never in the port itself;
- every subsystem is unit testable without Electron and without a window.

These rules are enforced mechanically by the `no-restricted-imports` boundary
rules in `eslint.config.mjs`.

| Folder         | Responsibility                                     | Introduced by |
| -------------- | -------------------------------------------------- | ------------- |
| `pdf/`         | Document loading, page rendering, text layer access | Milestone 1   |
| `word/`        | Pointer-to-word resolution and word normalisation   | Milestone 1   |
| `dictionary/`  | Definition lookup from a local dictionary source    | Milestone 3 (built) |
| `persistence/` | Documents, reading state and vocabulary storage     | Milestone 2/4 |
| `ai/`          | Contextual explanation provider abstraction         | Milestone 5   |
| `licensing/`   | Activation and entitlement checks                   | Milestone 8   |

See `docs/ARCHITECTURE.md` for how these fit together and
`docs/PRODUCT_SPEC.md` sections 10–14 for the product-level boundaries.
