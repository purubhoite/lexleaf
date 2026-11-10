# licensing

Owns activation state and entitlement checks.

- Port: an entitlement interface the UI can query synchronously.
- The reading experience must keep working when the licensing server is
  unreachable (PRODUCT_SPEC section 18, AGENTS.md section 11).
- Must not be consulted from arbitrary UI components.

Introduced by Milestone 8. Empty until then.
