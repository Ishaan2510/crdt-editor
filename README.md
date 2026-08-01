<div align="center">

# Collaborative Editor

**A real-time collaborative rich-text editor built on a hand-written RGA CRDT, with offline editing, reconnect merge, and a relay that never sees document state.**

Multiple people edit the same document at once. Concurrent edits converge without data loss, editing continues while disconnected, and reconnecting merges both sides. No CRDT library, no OT library, no managed sync service.

### [→ Live Demo](https://crdt-collab-editor.vercel.app)

**Demo video:** [Watch](https://drive.google.com/file/d/1J5w880aAXZYIKXNxJxVPjz43BW25nhNV/view?usp=sharing)

[![Live App](https://img.shields.io/badge/Live_App-crdt--collab--editor-brightgreen?style=for-the-badge&logo=vercel)](https://crdt-collab-editor.vercel.app)
[![Relay](https://img.shields.io/badge/Relay-Render-46E3B7?style=for-the-badge&logo=render&logoColor=white)](https://crdt-editor-8abb.onrender.com/health)

[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-32_tests-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![fast-check](https://img.shields.io/badge/fast--check-property_based-8A2BE2?style=flat-square)](https://fast-check.dev/)
[![WebSocket](https://img.shields.io/badge/Transport-WebSocket-010101?style=flat-square)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

</div>

---

## Try It

Open the live URL, click **Copy link**, and open that link in a second window. Both tabs are now editing the same document.

> The relay runs on a free tier and sleeps after 15 minutes idle, so the first load can take up to a minute to connect. The document is editable immediately either way, and anything typed before the relay wakes syncs once it does. To skip the wait, open [`/health`](https://crdt-editor-8abb.onrender.com/health) first.

---

## What This Solves

Two people edit `HELLO`. Alice inserts `X` at index 2. Bob concurrently deletes index 1. Alice's operation says "insert at index 2", but by the time it reaches Bob his document is `HLLO` and index 2 means something else entirely. The operation is not slightly wrong, it is meaningless.

**Positional indices are only valid against the exact document state that produced them.** Every approach to collaborative editing is a different answer to that.

Operational Transformation keeps sending index-based operations and rewrites each incoming operation against the operations the sender had not seen. It works, but convergence under three or more concurrent operations (the TP2 property) is notoriously difficult, and production OT systems dodge it by having a central server impose a total order.

This build requires that the server not be the source of truth, which removes that escape hatch. So the position problem is designed out rather than transformed away: every character carries a permanent identity, and operations reference identities instead of positions.

---

## Architecture

```
     ┌───────────────────────────┐      ┌───────────────────────────┐
     │   Browser A (Vercel)      │      │   Browser B (Vercel)      │
     │                           │      │                           │
     │   editor/  ──intent──▶    │      │    ◀──intent──  editor/   │
     │   crdt/    ◀──render──    │      │    ──render──▶  crdt/     │
     │   sync/                   │      │                  sync/    │
     └─────────────┬─────────────┘      └─────────────┬─────────────┘
                   │                                  │
                   │      WebSocket, JSON operations  │
                   └───────────────┬──────────────────┘
                                   ▼
                   ┌───────────────────────────────────┐
                   │   Relay (Render)                  │
                   │   server/index.js                 │
                   │                                   │
                   │   append-only operation log       │
                   │   version vector { site: lamport }│
                   │   socket set per room             │
                   │                                   │
                   │   imports no CRDT code            │
                   │   cannot render the document      │
                   └───────────────────────────────────┘
```

Convergence happens independently on every client. The relay stores opaque JSON it never opens, so a client joining an empty room has somewhere to fetch history from. **Storing operations is not the same as deciding state.**

| Layer | Responsibility | Knows about |
|---|---|---|
| `src/crdt/` | Node set, merge, traversal, ordering | Nothing else. No DOM, no network, no blocks |
| `src/editor/` | Intent capture, render, selection, presence overlay | The CRDT's public API only |
| `src/sync/` | WebSocket client, version vector exchange | Opaque operations |
| `server/` | Op log, version vector, socket fanout | Nothing at all |

`src/crdt/ops.js` is the only file where both a character id and a document index exist. The editor never sees an id positionally, and the CRDT never sees an index.

---

## The Algorithm: RGA

Every character is a node with a globally unique identifier assigned once at creation and never changed. An insert does not say "at index 2", it says "after the character with id X". Ids never move, so the operation stays correct no matter what happens to the document around it.

```js
{
  id:         { site: 'k3f9a2', lamport: 7 },
  char:       'X',
  parent:     { site: 'aa41b0', lamport: 3 },   // insert after this character
  deleted:    false,
  attrs:      { bold: true },
  attrClocks: { bold: { site: 'k3f9a2', lamport: 9 } }
}
```

### Identity

`site` is a random string generated once per browser tab. `lamport` is a Lamport clock with two rules:

| Event | Rule |
|---|---|
| Local edit | `lamport = lamport + 1` |
| Receiving a remote operation | `lamport = max(mine, theirs) + 1` |

The second rule guarantees that if you have seen my operation, your next timestamp exceeds mine. Causality is preserved with no wall clocks, no server, and no coordination. When two timestamps collide, that collision is precisely the signal that the two edits were concurrent.

The pair `(site, lamport)` is unique without any central allocator. The same clock serves two purposes: ordering inserts, and resolving formatting conflicts.

### Structure and traversal

Because every node points at its parent, the node set forms a tree. Text typed straight through is a chain one node deep per character. Two people typing at the same position produces a node with two children.

The visible document is a depth-first walk: visit a node, emit its character if it is not a tombstone, walk its children, then move to the next sibling.

### Sibling ordering

When a node has several children, every replica must sort them identically or the documents render differently and stay different forever. The comparator in `src/crdt/id.js` is **descending Lamport, then ascending site id**.

Descending is not arbitrary. Placing your caret after `H` and typing means you expect your character immediately after `H`, ahead of anything already sitting there. A newer insert claiming that position is a more recent statement of intent, so it sorts closer to the parent. Ascending order would push every new insert to the far end of the sibling list and reverse the text.

The site id tiebreak carries no meaning. It exists only because two concurrent inserts can produce the same Lamport value and the sort must still be deterministic on every replica. Any consistent rule works.

### Deletes are tombstones

Deleting marks `deleted: true` and removes nothing. This is what makes the hardest scenario work: a user inserting into text that another user simultaneously deleted. The insert references a parent id, and if deleting had removed that node the insert would wait forever for a parent that will never arrive, losing the character. The tombstone keeps the attachment point alive.

Cost: the structure only grows. See [Limitations](#limitations).

---

## The Merge Function

Document state is a **set of nodes keyed by unique id**. Merging two states is set union. Rendering is a deterministic traversal of that set. `Doc.apply(op)` in `src/crdt/document.js` is the merge, and it is the same code path for local and remote operations, because there is no distinction between them.

| Property | Why it holds | Asserted in |
|---|---|---|
| Commutative | Set union is commutative and the render is a pure function of the set, so the output does not depend on arrival order | Two fresh replicas fed the same ops in opposite orders render identically |
| Associative | Set union is associative | Three replicas' ops grouped two different ways |
| Idempotent | Every operation carries a unique id, so re-delivery is a no-op | Re-delivery tests plus duplicate injection in the fuzzer |

Idempotence per operation type: an insert whose id is already in the node map returns immediately, a delete whose target is already tombstoned returns immediately, and a format whose stored attribute clock is not dominated by the incoming id writes nothing. This matters in practice, not just in theory, because the relay rebroadcasts and reconnect deliberately re-requests operation ranges that may overlap what a client already has.

### The one ordering constraint

The set-union argument describes the final state, not the application procedure. An insert cannot be applied before the operation that created its parent, because there is nowhere to attach it. The same is true of a delete arriving before its target and a format arriving before its characters.

This is **causal dependency**, handled by a pending buffer in `Doc._drain`. An operation that is not ready is buffered and retried whenever new operations land, looping until a full pass applies nothing new. Format operations apply to whichever of their targets have arrived and re-buffer for the rest.

So convergence requires **causal delivery, not total order**. Causal delivery comes from the buffer on each client, not from sequence numbers on the wire, which is what keeps the server free of any ordering responsibility. Every test asserts `pending.length === 0` after delivery, proving the buffer always drains.

---

## Concurrent Scenarios

All covered in `src/crdt/convergence.test.js` and `src/crdt/format.test.js`.

| Scenario | Resolution |
|---|---|
| Concurrent inserts at the same position | Both survive as siblings, ordered by the comparator, identically on every replica |
| Concurrent typing of whole words at one position | Words stay contiguous rather than interleaving per character, because each character parents to the one before it |
| Concurrent deletes of the same character | Both tombstone the same node, second is a no-op |
| Insert into a concurrently deleted range | Insert survives, parent tombstone keeps the attachment point alive |
| Whole document deleted concurrently with an insert | Insert survives, everything else tombstoned |
| Different attributes on the same characters | Both apply, clocks are per attribute key |
| Same attribute set to conflicting values | Lamport last-writer-wins, same verdict on every replica |
| Partially overlapping format ranges | Resolved per character, converges |
| Formatting characters another user is deleting | Converges, formatting a tombstone is harmless |
| Any operation delivered before its dependency | Buffered, applied on arrival |
| Any operation delivered twice | No-op |

---

## Key Engineering Decisions

### 1. Controlled `contenteditable`

The usual `contenteditable` pattern lets the browser mutate the DOM and reads the result afterwards, which is where most editor bugs originate.

**Inversion:** `beforeinput` fires with the user's intent before any mutation. Every event is `preventDefault()`ed, the intent becomes CRDT operations, and the DOM is rebuilt from the CRDT. The browser never edits anything. The DOM is a projection with exactly one source of truth behind it.

`getTargetRanges()` supplies word-delete and line-delete for free without reimplementing word boundaries.

### 2. Caret positions are character ids, not offsets

A caret stored as offset 12 drifts silently when a remote insert lands above it. Stored as "after character `(k3f9, 7)`" it cannot drift, because ids never move. `Doc.caretAfter` walks tombstones, so a caret anchored to a character someone just deleted resolves to where that character used to be.

One mechanism does three jobs: the local caret across DOM rebuilds, the local caret across remote edits, and every remote cursor.

### 3. Presence lives outside the CRDT

A CRDT is designed never to forget anything, which is why deletes leave tombstones. Cursor position is worthless the moment someone disconnects, so storing it in the document would accumulate permanent tombstones for transient facts.

**Fix:** the relay keeps presence in an ephemeral map and drops it on disconnect. Cursor positions are still transmitted as character ids, for the same reason inserts are.

The overlay is an absolutely positioned sibling layer with `pointer-events: none`, measured from the live DOM with `getClientRects`. Injecting remote carets into the editor's own DOM would put foreign elements inside `contenteditable`, where the local caret could land inside them and corrupt the offset mapping.

### 4. Block attributes on the terminating newline

Inline attributes (`bold`, `italic`, `code`) live on each character with a Lamport clock **per attribute key**. Alice bolding and Bob italicising the same word touch different keys and both survive. Only the same key on the same character is a real conflict, resolved by last-writer-wins under a total order over operation ids.

Block attributes (`heading`, `list`) live on the newline character that terminates the block, so the document stays one flat character sequence with no separate block tree to keep in sync. Pressing Enter is an ordinary character insert, which makes splitting a heading in half work correctly for free.

An empty document is seeded with a fixed-id newline so there is always a terminator to attach to. The id is hardcoded so every replica constructs the identical node and the duplicate check collapses them into one.

### 5. Per-character attributes over range-based marks

The better long-term model stores formatting as separate objects spanning two character-id anchors (`{ type: 'bold', start, end }`) rather than per character. It is more compact and it preserves range intent, which is what hyperlinks and anchored comments actually need. Peritext is the reference for doing it correctly.

It was not built because concurrent marks need boundary stickiness rules that differ per mark type (typing after bold should extend it, typing after a hyperlink should not), and unformatting a subrange requires either splitting another user's mark object or layering negative marks with precedence rules. Either is a project on its own.

Note also that marks still have to compute a per-character answer at render time by gathering every overlapping mark and sorting by timestamp. Per-character attributes store that answer once at write time and render with a lookup.

**What it costs:** memory, and the loss of range intent, which rules out hyperlinks and comments later. Sticky formatting, by contrast, is four lines under this model and genuinely hard under marks.

### 6. Offline is a property of the data structure, not the network layer

There is no outbox and no reconciliation code path. Every operation enters `doc.log` when it is created, connected or not.

On reconnect, client and server exchange version vectors (`{ siteId: highestLamport }`) and each sends what the other's vector does not cover. Applying those operations is the entire merge, because operations are commutative and idempotent. The offline requirement was satisfied by the data structure chosen on day one.

One number per site is sufficient because a site issues operations in strictly increasing Lamport order and the relay preserves per-connection order, so holding `(s, n)` implies holding every operation from `s` below `n`.

The exchange is symmetric in both directions, which means a **server restart needs no special handling**: the relay returns with an empty vector, and the first client to connect uploads its whole log, rebuilding the room from a client. Relevant here, since free-tier instances restart routinely.

Reconnection uses exponential backoff from 500ms to 8s. **Go offline** in the UI forces the disconnected state for demonstration.

---

## Tests

32 tests across four files. `npm test`.

| File | Covers |
|---|---|
| `document.test.js` | Local editing, causal delivery of out-of-order inserts and deletes, idempotent re-delivery |
| `convergence.test.js` | The named concurrent scenarios, plus explicit commutativity, associativity, and idempotence assertions |
| `format.test.js` | Per-key independence, last-writer-wins, partial overlap, formatting concurrently deleted text, partial application with re-buffering, the seeded block terminator |
| `fuzz.test.js` | Property-based convergence under randomised operation logs |

`fuzz.test.js` is the file that separates proof from demonstration. Using `fast-check`, it generates up to 60 random operations across three replicas editing blind, then delivers the full operation log to each replica in a **different shuffled order with duplicates injected**, and asserts all three render byte-identical with empty pending buffers. 300 generated cases for the three-replica property, 200 for the offline catch-up property.

Hand-written tests only cover cases the author thought of. If the comparator, buffer, or tombstone logic is wrong in any reachable case, the fuzzer finds it, and `fast-check` shrinks the failure to the smallest reproducing script, usually two or three operations, with a seed for reproduction.

---

## Tech Stack

| Layer | Technology |
|---|---|
| CRDT | Hand-written RGA, Lamport clocks, tombstones, per-key attribute clocks |
| Editor | Controlled `contenteditable` via `beforeinput` and `getTargetRanges()` |
| Rendering | Full DOM rebuild from CRDT state on every edit |
| Presence | Absolutely positioned overlay, `getClientRects` measurement, `pointer-events: none` |
| Transport | Native WebSocket, `ws` on the relay |
| Sync | Symmetric version vector exchange, exponential backoff 500ms to 8s |
| Testing | Vitest, `fast-check` property-based fuzzing |
| Build | Vite |
| Hosting | Vercel (client), Render free tier (relay) |
| Client runtime dependencies | None |

---

## Local Development

```bash
npm install
cd server && npm install && cd ..

npm run relay   # WebSocket relay on :8787
npm run dev     # Vite dev server on :5173
npm test        # 32 tests across 4 files
```

---

## Project Structure

```
crdt-editor/
├── src/
│   ├── crdt/
│   │   ├── id.js               sibling comparator, Lamport clock
│   │   ├── document.js         node set, apply(), _drain() pending buffer
│   │   ├── ops.js              the only index <-> id boundary
│   │   ├── document.test.js
│   │   ├── convergence.test.js
│   │   ├── format.test.js
│   │   └── fuzz.test.js
│   ├── editor/
│   │   ├── editor.js           beforeinput intent capture
│   │   ├── render.js           DOM rebuild from CRDT state
│   │   ├── blocks.js           block attributes on terminating newline
│   │   ├── selection.js        caret as character id
│   │   └── presence.js         remote cursor overlay
│   └── sync/
│       ├── client.js           WebSocket, reconnect, backoff
│       └── vector.js           version vector exchange
└── server/
    └── index.js                op log, version vector, socket set
```

---

## Limitations

**Tombstones are never collected.** Deleted characters remain forever, so a document with heavy edit churn grows without bound. The standard fix is garbage collection once every replica has acknowledged a delete, which requires tracking acknowledgement state per site.

**Full DOM rebuild per keystroke.** Correct and simple, but O(document) on every edit. The fix is diffing the block list and patching only changed blocks.

**Presence re-measures on every render**, calling `getClientRects` more often than necessary. Should be throttled and measured only when layout actually changes.

**No IME composition support.** Composed input for Japanese, Chinese, and similar requires `compositionstart` and `compositionend` handling and is not implemented.

**No undo.** Undo in a CRDT is not a stack pop, it is generating inverse operations that respect concurrent edits from other users.

**No authentication.** Display names are client-supplied and unverified. This cannot corrupt the document, because convergence depends only on operation ids, never on who claims to have sent them.

**Room memory is not durable.** The relay holds operation logs in memory and drops rooms after 30 minutes with no connections. Any client still holding the document restores it on reconnect via the symmetric vector exchange.

---

## Constraints

No Y.js, Automerge, ShareDB, or any CRDT or OT library. No Firebase, Supabase Realtime, or managed sync service. No collaborative editing SDK. No rich-text editor framework, the editor drives `contenteditable` directly.

Dependencies: `ws` on the server. `vite`, `vitest`, and `fast-check` in development. Nothing at runtime on the client.

---

*Built by [Ishaan Goswami](https://github.com/Ishaan2510) — CS undergrad, PDEU + IIT Madras*
