/**
 * Position-to-id translation. The CRDT never sees an index;
 * the editor never sees an id. This is the only place both exist.
 */

/** Insert text at a visible offset. Returns ops in causal order. */
export function insertAt(doc, index, text) {
  const vis = doc.visible();
  const clamped = Math.max(0, Math.min(index, vis.length));
  let parent = clamped === 0 ? null : vis[clamped - 1].id;

  const ops = [];
  for (const ch of text) {
    const op = doc.localInsert(parent, ch);
    ops.push(op);
    parent = op.id; // each character attaches to the one before it
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