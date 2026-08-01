/** DOM point to CRDT position. */
export function indexFromDom(container, offset, map) {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = map.find(e => e.node === container);
    if (entry) return entry.start + Math.min(offset, entry.len);
    return null;
  }

  // An element container means an empty block, or a caret parked
  // between children. Resolve through the nearest mapped descendant.
  const empty = map.find(e => e.empty && e.node === container);
  if (empty) return empty.start;

  const inside = map.filter(e => container.contains(e.node));
  if (inside.length === 0) return null;
  return offset === 0
    ? inside[0].start
    : inside[inside.length - 1].start + inside[inside.length - 1].len;
}

/** CRDT position to DOM point. */
export function domFromIndex(index, map) {
  if (map.length === 0) return null;

  let last = map[0];
  for (const e of map) {
    if (e.empty && index === e.start) return { node: e.node, offset: 0 };
    if (index >= e.start && index < e.start + e.len) {
      return { node: e.node, offset: index - e.start };
    }
    if (e.start <= index) last = e;
  }

  if (last.empty) return { node: last.node, offset: 0 };
  return { node: last.node, offset: Math.min(index - last.start, last.len) };
}

export function setSelection(startPoint, endPoint) {
  if (!startPoint) return;
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  const e = endPoint ?? startPoint;
  range.setEnd(e.node, e.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}