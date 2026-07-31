import { ROOT, idStr, compareIds, makeSiteId } from './id.js';

export class Doc {
  constructor(siteId = makeSiteId()) {
    this.site = siteId;
    this.lamport = 0;

    /** @type {Map<string, object>} idStr -> node */
    this.nodes = new Map();

    /** @type {Map<string, object[]>} parent idStr -> children, kept sorted */
    this.children = new Map();
    this.children.set(ROOT, []);

    /** Operations that arrived before their parent did. */
    this.pending = [];
  }

  /** Advance the Lamport clock. Pass a remote value when applying a remote op. */
  tick(remote = 0) {
    this.lamport = Math.max(this.lamport, remote) + 1;
    return this.lamport;
  }

  /**
   * Called by the editor. Creates an operation, applies it locally,
   * and returns it so the sync layer can broadcast it.
   * afterId of null means insert at the very start of the document.
   */
  localInsert(afterId, char) {
    const op = {
      type: 'insert',
      id: { site: this.site, lamport: this.tick() },
      char,
      parent: afterId,
      attrs: {}
    };
    this.applyInsert(op);
    return op;
  }

  /** Called by the sync layer. Never called by the editor. */
  applyRemote(op) {
    this.tick(op.id.lamport);
    this.apply(op);
  }

  /**
   * Apply one operation, then retry anything that was waiting on it.
   * Returns true if the document actually changed.
   */
  apply(op) {
    const changed = this._tryApply(op);
    if (changed) this._drain();
    return changed;
  }

  _tryApply(op) {
    if (op.type === 'insert') return this._tryInsert(op);
    if (op.type === 'delete') return this._tryDelete(op);
    return false;
  }

  _tryInsert(op) {
    const key = idStr(op.id);

    // Already applied. Re-delivery must be a no-op.
    if (this.nodes.has(key)) return false;

    // Causally not ready: we have never seen the character it attaches to.
    const parentKey = idStr(op.parent);
    if (op.parent !== null && !this.nodes.has(parentKey)) {
      this.pending.push(op);
      return false;
    }

    const node = {
      id: op.id,
      char: op.char,
      parent: op.parent,
      deleted: false,
      attrs: { ...(op.attrs ?? {}) },
      attrClocks: {}
    };

    this.nodes.set(key, node);

    let siblings = this.children.get(parentKey);
    if (!siblings) {
      siblings = [];
      this.children.set(parentKey, siblings);
    }

    // Keep siblings sorted on write so render never sorts.
    let i = 0;
    while (i < siblings.length && compareIds(siblings[i].id, node.id) < 0) i++;
    siblings.splice(i, 0, node);

    return true;
  }

  _tryDelete(op) {
    const node = this.nodes.get(idStr(op.target));

    // The character has not arrived yet. Wait for it.
    if (!node) {
      this.pending.push(op);
      return false;
    }

    // Already a tombstone. Re-delivery must be a no-op.
    if (node.deleted) return false;

    node.deleted = true;
    return true;
  }

  /**
   * Retry buffered operations until a full pass produces no change.
   * Flat loop rather than recursion: reversed delivery of a long paste
   * would otherwise nest one stack frame per character.
   */
  _drain() {
    let progress = true;
    while (progress) {
      progress = false;
      const queued = this.pending;
      this.pending = [];
      for (const op of queued) {
        if (this._tryApply(op)) progress = true;
      }
    }
  }

  /** Editor entry point. Applies locally and returns the op to broadcast. */
  localInsert(afterId, char, attrs = {}) {
    const op = {
      type: 'insert',
      id: { site: this.site, lamport: this.tick() },
      char,
      parent: afterId,
      attrs
    };
    this.apply(op);
    return op;
  }

  /** Editor entry point. Tombstones a character. */
  localDelete(targetId) {
    const op = {
      type: 'delete',
      id: { site: this.site, lamport: this.tick() },
      target: targetId
    };
    this.apply(op);
    return op;
  }

  /**
   * Non-deleted nodes in document order.
   * The editor maps DOM offsets to ids with this, so it is not test-only.
   * Deleted nodes are still traversed because their children are live.
   */
  visible() {
    const out = [];
    const stack = [...(this.children.get(ROOT) ?? [])].reverse();
    while (stack.length) {
      const node = stack.pop();
      if (!node.deleted) out.push(node);
      const kids = this.children.get(idStr(node.id));
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  render() {
    return this.visible().map(n => n.char).join('');
  }
}