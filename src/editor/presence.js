/**
 * Remote cursors are drawn as absolutely positioned overlays measured
 * from the live DOM. They are never inserted into the editor's own DOM,
 * because a remote cursor is not part of the document and must not be
 * something the local caret can land inside.
 */
export class Presence {
  constructor(layer, editor) {
    this.layer = layer;
    this.editor = editor;
    this.peers = new Map();   // site -> { name, color, anchor, focus }

    // Cursor pixel positions depend on layout, so re-measure on resize.
    this.onResize = () => this.draw();
    window.addEventListener('resize', this.onResize);
  }

  setPeers(list) {
    const next = new Map();
    for (const p of list) {
      const old = this.peers.get(p.site);
      next.set(p.site, { ...p, anchor: old?.anchor ?? null, focus: old?.focus ?? null });
    }
    this.peers = next;
    this.draw();
  }

  join(peer) {
    if (!this.peers.has(peer.site)) this.peers.set(peer.site, { ...peer, anchor: null, focus: null });
    this.draw();
  }

  leave(site) {
    this.peers.delete(site);
    this.draw();
  }

  /** Cursor positions arrive as character ids, not offsets. */
  update(site, anchor, focus) {
    const peer = this.peers.get(site);
    if (!peer) return;
    peer.anchor = anchor;
    peer.focus = focus;
    this.draw();
  }

  clear() {
    this.peers.clear();
    this.draw();
  }

  roster() {
    return [...this.peers.values()];
  }

  draw() {
    this.layer.replaceChildren();
    const base = this.layer.getBoundingClientRect();

    for (const peer of this.peers.values()) {
      if (peer.anchor === undefined) continue;

      const a = this.editor.doc.caretAfter(peer.anchor);
      const b = this.editor.doc.caretAfter(peer.focus ?? peer.anchor);
      const [from, to] = a <= b ? [a, b] : [b, a];

      if (to > from) this.drawSelection(peer, from, to, base);
      this.drawCaret(peer, b, base);
    }

    this.onRoster?.(this.roster());
  }

  /** Client rects for a CRDT range, via a temporary DOM Range. */
  rects(from, to, base) {
    const start = this.editor.pointAt(from);
    const end = this.editor.pointAt(to);
    if (!start || !end) return [];
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      return [];
    }
    return [...range.getClientRects()].map(r => ({
      top: r.top - base.top,
      left: r.left - base.left,
      width: r.width,
      height: r.height
    }));
  }

  drawSelection(peer, from, to, base) {
    for (const r of this.rects(from, to, base)) {
      if (r.width < 1) continue;
      const el = document.createElement('div');
      el.className = 'peer-selection';
      el.style.cssText =
        `top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;background:${peer.color}`;
      this.layer.appendChild(el);
    }
  }

  drawCaret(peer, at, base) {
    const [r] = this.rects(at, at, base);
    if (!r) return;

    const caret = document.createElement('div');
    caret.className = 'peer-caret';
    caret.style.cssText =
      `top:${r.top}px;left:${r.left}px;height:${r.height || 20}px;background:${peer.color}`;

    const tag = document.createElement('span');
    tag.className = 'peer-label';
    tag.textContent = peer.name;
    tag.style.background = peer.color;
    caret.appendChild(tag);

    this.layer.appendChild(caret);
  }
}