# ai

Owns contextual explanation of a word inside its sentence.

- Port: a context-explainer interface (ADR-005); the reader must never depend
  on a specific vendor, and the application must remain usable when AI is
  unavailable.
- Only the minimum necessary text may leave the machine; never a whole
  document (PRODUCT_SPEC section 15).
- Must not replace deterministic dictionary lookup.

Built in Milestone 5. `docs/AI_EXPLANATION_INVESTIGATION.md` is the contract
this implements; ADR-027 records the port, the payload and the provider
boundary, and ADR-028 records identity and persistence.

## What this feature is, exactly

One word, in one short passage, explained once, on request, from the
dictionary popup. Nothing else: no chat, no document questions, no
summarisation, no translation, no agents and no background work. The reader
reaches it by double-clicking a word and pressing a button that says where
the sentence would go before they press it.

## What is here

| File | Responsibility |
| ---- | -------------- |
| `limits.ts` | Every bound in one place: 6 senses, 200 characters a definition, 240 a passage, 4,000 a prompt, 2,000 an explanation, 32,768 response bytes, 20,000 ms, a 32-entry cache. |
| `types.ts` | The port: `ContextExplainer`, the allowlisted request, the explanation, and the closed set of failures. |
| `prompt.ts` | Builds the request from allowlisted fields only, and assembles the two prompt messages around a nonce fence. |
| `parseResponse.ts` | Turns provider content into an explanation or a typed failure: strict JSON, no repair, no partial trust. |
| `identity.ts` | What makes two explanations the same question: the seven dimensions, and the key they join into. |

Nothing here imports `node:*`, performs I/O, or knows what HTTP is. A test in
`src/main/ai/aiNetworkPolicy.test.ts` enforces that: the core of this feature
is pure, so the rules below can be read off the code rather than trusted.

## The rules the code exists to keep

**The payload is an allowlist, not a redaction.** `buildExplanationRequest`
accepts named fields and constructs a new object; a `SavedOccurrence`, a
document id, a file name, a path, a page number or an anchor cannot reach a
provider because there is no field for them. Adding one would be a change to
this file, visible in review.

**The passage is bounded before it is anything else.** 240 characters, one
word's surroundings, whitespace collapsed. Six senses of at most 200
characters each ground the question. A prompt that would exceed 4,000
characters is refused rather than trimmed into something the reader did not
see.

**The document's text is data.** The excerpt is fenced with a per-request
nonce and the instructions say so. This is **structurally mitigated, not
empirically proven**: no claim is made that a crafted PDF cannot influence a
model, only that the text is never concatenated into the instruction position
and that the result is parsed, bounded and rendered as plain text.

**A reply is parsed, never repaired.** Strict JSON, one object, known fields.
A malformed, empty or oversized reply is a typed failure with no provider text
in it. A sense index that does not point at a sense that was sent becomes no
index at all.

**Identity is all seven dimensions.** Item or normalised word, document, page,
context hash, prompt version, provider id, model id. Anchors and page offsets
are excluded on purpose: they move when a document is re-rendered, and an
explanation is about words, not coordinates. There is no partial hit — a row
for the same word on the same page from a different passage is a *previous*
explanation, labelled as such, never an answer.

## Where the rest of it lives

- `src/main/ai/` — configuration, the fingerprint, the OpenAI-compatible
  adapter, abort reasons, and the service that decides what to send, what to
  store and when to give up. Credentials exist only here.
- `src/main/vocabulary/explanationStore.ts` — the only SQL for explanations.
- `src/shared/ipc/aiContracts.ts` — the four channels' shapes, parsed in both
  directions.
- `src/renderer/src/reader/ai/` — the hook and the control inside the popup.
