const INLINE = ['bold', 'italic', 'code'];

export function inlineOf(attrs) {
  const out = {};
  for (const k of INLINE) if (attrs[k]) out[k] = attrs[k];
  return out;
}

function sameInline(a, b) {
  return INLINE.every(k => (a[k] ?? null) === (b[k] ?? null));
}

/**
 * Turn the flat CRDT character list into blocks and runs.
 * A newline both ends a block and carries that block's type,
 * so there is no separate block structure to keep in sync.
 */
export function buildBlocks(nodes) {
  const blocks = [];
  let cur = { start: 0, spans: [], attrs: {}, end: 0, terminator: null };

  nodes.forEach((n, i) => {
    if (n.char === '\n') {
      cur.end = i;
      cur.attrs = n.attrs;
      cur.terminator = n.id;
      blocks.push(cur);
      cur = { start: i + 1, spans: [], attrs: {}, end: i + 1, terminator: null };
      return;
    }
    const last = cur.spans[cur.spans.length - 1];
    if (last && sameInline(last.attrs, n.attrs)) {
      last.text += n.char;
      last.len++;
    } else {
      cur.spans.push({ text: n.char, attrs: inlineOf(n.attrs), start: i, len: 1 });
    }
  });

  // Text after the final newline, or a document with no newline at all.
  if (cur.spans.length || blocks.length === 0) {
    cur.end = nodes.length;
    blocks.push(cur);
  }
  return blocks;
}