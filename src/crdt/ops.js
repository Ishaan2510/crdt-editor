/**
 * Position-to-id translation. The CRDT never sees an index;
 * the editor never sees an id. This is the only place both exist.
 */

/** Insert text at a visible offset. Returns ops in causal order. */
export function insertAt(doc, index, text, attrs = {}) {
  const vis = doc.visible();
  const clamped = Math.max(0, Math.min(index, vis.length));
  let parent = clamped === 0 ? null : vis[clamped - 1].id;

  const ops = [];
  for (const ch of text) {
    // A newline is a block terminator and must not carry inline formatting.
    const op = doc.localInsert(parent, ch, ch === '\n' ? {} : attrs);
    ops.push(op);
    parent = op.id;
  }
  return ops;
}

/** Delete `count` visible characters starting at `index`. */
export function deleteAt(doc, index, count) {
  const vis = doc.visible();
  const ops = [];
  for (let i = index; i < index + count && i < vis.length; i++) {
    if (i >= 0) ops.push(doc.localDelete(vis[i].id));
  }
  return ops;
}

/** Deliver a batch of remote ops. Order-independent by design. */
export function deliver(doc, ops) {
  for (const op of ops) doc.applyRemote(op);
}

/** Format a visible range [start, end). Returns the op, or null if empty. */
export function formatRange(doc, start, end, key, value) {
  const vis = doc.visible();
  const from = Math.max(0, start);
  const to = Math.min(end, vis.length);
  if (to <= from) return null;
  return doc.localFormat(vis.slice(from, to).map(n => n.id), key, value);
}

/**
 * Block formatting attaches to the newline that terminates the block
 * containing `index`, so heading and list live on one character.
 */
export function formatBlock(doc, index, key, value) {
  const vis = doc.visible();
  for (let i = Math.max(0, index); i < vis.length; i++) {
    if (vis[i].char === '\n') return doc.localFormat([vis[i].id], key, value);
  }
  return null;
}