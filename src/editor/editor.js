import { insertAt, deleteAt, formatRange, formatBlock } from '../crdt/ops.js';
import { buildBlocks, inlineOf } from './blocks.js';
import { renderDoc } from './render.js';
import { indexFromDom, domFromIndex, setSelection } from './selection.js';

/**
 * Controlled contenteditable. The browser is never allowed to modify
 * the DOM: every beforeinput is cancelled, translated into CRDT
 * operations, and the DOM is rebuilt from the CRDT afterwards.
 * The CRDT is the only source of truth.
 */
export class Editor {
  constructor(root, doc, { onOps = () => {}, onSelection = () => {} } = {}) {
    this.root = root;
    this.doc = doc;
    this.onOps = onOps;
    this.onSelection = onSelection;
    this.map = [];
    this.storedAttrs = null;  // format armed by the toolbar, not yet typed
    this.storedAt = null;

    root.setAttribute('contenteditable', 'true');
    root.setAttribute('spellcheck', 'false');

    root.addEventListener('beforeinput', e => this.onBeforeInput(e));
    document.addEventListener('selectionchange', () => {
      if (!this.root.contains(window.getSelection()?.anchorNode)) return;
      // A stored format belongs to one caret position. Moving cancels it.
      const r = this.range();
      if (this.storedAttrs && (!r || r.start !== this.storedAt)) {
        this.storedAttrs = null;
        this.storedAt = null;
      }
      this.onSelection(this.anchors());
    });

    this.refresh();
  }

  /* ---------- rendering ---------- */

  refresh(anchorId, focusId) {
    this.map = renderDoc(this.root, buildBlocks(this.doc.visible()));
    if (anchorId !== undefined) {
      const a = domFromIndex(this.doc.caretAfter(anchorId), this.map);
      const f = focusId === undefined
        ? a
        : domFromIndex(this.doc.caretAfter(focusId), this.map);
      setSelection(a, f);
    }
  }

  /** Reapply remote work without the local caret jumping. */
  applyRemote(ops) {
    const keep = this.focused() ? this.anchors() : null;
    for (const op of ops) this.doc.applyRemote(op);
    if (keep) this.refresh(keep.anchorId, keep.focusId);
    else this.refresh();
  }

  focused() {
    return this.root.contains(window.getSelection()?.anchorNode ?? null);
  }

  /* ---------- selection ---------- */

  range() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return null;
    const a = indexFromDom(r.startContainer, r.startOffset, this.map);
    const b = indexFromDom(r.endContainer, r.endOffset, this.map);
    if (a === null || b === null) return null;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  /** Caret as character ids, which survive concurrent remote edits. */
  anchors() {
    const r = this.range();
    if (!r) return { anchorId: null, focusId: null };
    return {
      anchorId: this.doc.anchorAt(r.start),
      focusId: this.doc.anchorAt(r.end)
    };
  }

  /** Range the browser intends to affect. Gives word and line deletes free. */
  targetRange(e) {
    const tr = e.getTargetRanges?.()[0];
    if (!tr) return this.range();
    const a = indexFromDom(tr.startContainer, tr.startOffset, this.map);
    const b = indexFromDom(tr.endContainer, tr.endOffset, this.map);
    if (a === null || b === null) return this.range();
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  /* ---------- input ---------- */

  onBeforeInput(e) {
    e.preventDefault();
    const t = e.inputType;

    if (t === 'insertText' || t === 'insertReplacementText') {
      return this.replace(this.range(), e.data ?? '');
    }
    if (t === 'insertFromPaste' || t === 'insertFromDrop') {
      const text = e.dataTransfer?.getData('text/plain') ?? '';
      return this.replace(this.range(), text);
    }
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      return this.enter(this.range());
    }
    if (t.startsWith('delete')) {
      return this.remove(this.targetRange(e));
    }
    if (t === 'formatBold') return this.toggleInline('bold');
    if (t === 'formatItalic') return this.toggleInline('italic');
    // historyUndo, insertCompositionText and the rest are cancelled above.
  }

  /**
   * Formatting a new character should inherit: from the first selected
   * character when replacing a selection, otherwise from the left
   * neighbour, falling back to the right at the start of a block.
   * Newlines are skipped because they carry block attrs, not inline ones.
   */
  inheritedAt(r) {
    const vis = this.doc.visible();
    const pick = n => (n && n.char !== '\n' ? inlineOf(n.attrs) : null);
    if (r.end > r.start) {
      const sel = pick(vis[r.start]);
      if (sel) return sel;
    }
    return pick(vis[r.start - 1]) ?? pick(vis[r.start]) ?? {};
  }

  /** Inherited formatting, overridden by anything the toolbar armed. */
  attrsForInsert(r) {
    const merged = { ...this.inheritedAt(r), ...(this.storedAttrs ?? {}) };
    for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
    return merged;
  }

  replace(r, text) {
    if (!r || !text) return;
    const attrs = this.attrsForInsert(r); // computed before the delete shifts things
    const ops = [];
    if (r.end > r.start) ops.push(...deleteAt(this.doc, r.start, r.end - r.start));
    ops.push(...insertAt(this.doc, r.start, text, attrs));
    this.commit(ops, ops[ops.length - 1].id);
  }

  remove(r) {
    if (!r || r.end <= r.start) return;
    const vis = this.doc.visible();
    const ops = [];

    for (let i = r.start; i < r.end && i < vis.length; i++) {
      // The document must always keep one block terminator, otherwise
      // there is nothing left for block formatting to attach to.
      if (vis[i].char === '\n' && i === vis.length - 1) continue;
      ops.push(this.doc.localDelete(vis[i].id));
    }
    if (!ops.length) return;
    this.commit(ops, this.doc.anchorAt(r.start));
  }

  /**
   * Enter splits a block. The new newline inherits the block's type so the
   * first half keeps its formatting; if the split leaves an empty second
   * half, its heading is cleared so Enter after a title gives a paragraph.
   */
  enter(r) {
    if (!r) return;
    const ops = [];
    if (r.end > r.start) ops.push(...deleteAt(this.doc, r.start, r.end - r.start));

    const vis = this.doc.visible();
    let ti = r.start;
    while (ti < vis.length && vis[ti].char !== '\n') ti++;
    const term = vis[ti];
    const atEnd = ti === r.start;

    const parent = r.start === 0 ? null : vis[r.start - 1].id;
    const op = this.doc.localInsert(parent, '\n', { ...(term?.attrs ?? {}) });
    ops.push(op);

    if (atEnd && term && term.attrs.heading) {
      ops.push(this.doc.localFormat([term.id], 'heading', null));
    }
    this.commit(ops, op.id);
  }

  /* ---------- formatting ---------- */

  toggleInline(key) {
    const r = this.range();
    if (!r) return;

    // Nothing selected: arm the format for the next keystroke.
    if (r.end === r.start) {
      const active = this.attrsForInsert(r)[key];
      this.storedAttrs = { ...(this.storedAttrs ?? {}), [key]: active ? null : true };
      this.storedAt = r.start;
      return;
    }

    const vis = this.doc.visible();
    const on = vis.slice(r.start, r.end).every(n => n.attrs[key]);
    const op = formatRange(this.doc, r.start, r.end, key, on ? null : true);
    if (!op) return;
    this.commit([op], this.doc.anchorAt(r.start), this.doc.anchorAt(r.end));
  }

  toggleBlock(key, value) {
    const r = this.range();
    if (!r) return;
    const vis = this.doc.visible();
    let ti = r.start;
    while (ti < vis.length && vis[ti].char !== '\n') ti++;
    const current = vis[ti]?.attrs[key] ?? null;
    const op = formatBlock(this.doc, r.start, key, current === value ? null : value);
    if (!op) return;
    this.commit([op], this.doc.anchorAt(r.start), this.doc.anchorAt(r.end));
  }

  commit(ops, anchorId, focusId) {
    this.refresh(anchorId, focusId);
    this.onOps(ops);
  }
}