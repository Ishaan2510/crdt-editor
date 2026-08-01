/**
 * Blocks to DOM. Returns a map from text nodes back to CRDT positions,
 * which is the only way the caret can be put back after a rebuild.
 */
export function renderDoc(root, blocks) {
  root.replaceChildren();
  const map = [];
  let list = null;

  for (const b of blocks) {
    const el = blockElement(b);

    if (b.attrs.list === 'bullet') {
      if (!list) {
        list = document.createElement('ul');
        root.appendChild(list);
      }
      list.appendChild(el);
    } else {
      list = null;
      root.appendChild(el);
    }

    fillBlock(el, b, map);
  }

  return map;
}

function blockElement(b) {
  if (b.attrs.list === 'bullet') return document.createElement('li');
  if (b.attrs.heading === 1) return document.createElement('h1');
  if (b.attrs.heading === 2) return document.createElement('h2');
  return document.createElement('p');
}

function fillBlock(el, b, map) {
  if (b.spans.length === 0) {
    // An empty element has no height and cannot hold a caret.
    el.appendChild(document.createElement('br'));
    map.push({ node: el, start: b.start, len: 0, empty: true });
    return;
  }

  for (const span of b.spans) {
    const text = document.createTextNode(span.text);
    let node = text;
    if (span.attrs.code) node = wrap('code', node);
    if (span.attrs.italic) node = wrap('em', node);
    if (span.attrs.bold) node = wrap('strong', node);
    el.appendChild(node);
    map.push({ node: text, start: span.start, len: span.len });
  }
}

function wrap(tag, child) {
  const el = document.createElement(tag);
  el.appendChild(child);
  return el;
}