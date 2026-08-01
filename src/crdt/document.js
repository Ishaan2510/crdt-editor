import { ROOT, GENESIS, idStr, compareIds, dominates, makeSiteId } from './id.js';

export class Doc {
  constructor(siteId = makeSiteId(), { seed = false } = {}) {
    this.site = siteId;
    this.lamport = 0;
    this.nodes = new Map();
    this.children = new Map();
    this.children.set(ROOT, []);
    this.pending = [];

    // The editor asks for a document that always has one block terminator.
    // The CRDT itself stays content-agnostic.
    if (seed) {
      this.apply({ type: 'insert', id: GENESIS, char: '\n', parent: null, attrs: {} });
    }
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
    if (op.type === 'format') return this._tryFormat(op);
    return false;
  }

  /**
   * Last-writer-wins per attribute key. A format op may cover characters
   * that have not all arrived, so it applies to what is present and
   * re-buffers for the rest.
   */
  _tryFormat(op) {
    let changed = false;
    let missing = false;

    for (const target of op.targets) {
      const node = this.nodes.get(idStr(target));
      if (!node) {
        missing = true;
        continue;
      }

      const prev = node.attrClocks[op.key];
      // Not strictly newer, so an older or re-delivered op cannot overwrite.
      if (prev && !dominates(op.id, prev)) continue;

      node.attrs[op.key] = op.value;
      node.attrClocks[op.key] = op.id;
      changed = true;
    }

    if (missing) this.pending.push(op);
    return changed;
  }

  /** Editor entry point. One op covers a whole selection. */
  localFormat(targetIds, key, value) {
    const op = {
      type: 'format',
      id: { site: this.site, lamport: this.tick() },
      targets: targetIds,
      key,
      value
    };
    this.apply(op);
    return op;
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

    // Attributes carried on an insert need a clock too, so a later
    // format op can dominate them by the same rule as everything else.
    for (const k of Object.keys(node.attrs)) node.attrClocks[k] = op.id;

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
   * Every node in document order, tombstones included.
   * Deleted nodes stay in the walk because their children are live
   * and because a caret can be anchored to one.
   */
  ordered() {
    const out = [];
    const stack = [...(this.children.get(ROOT) ?? [])].reverse();
    while (stack.length) {
      const node = stack.pop();
      out.push(node);
      const kids = this.children.get(idStr(node.id));
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  /** Non-deleted nodes in document order. This is what the screen shows. */
  visible() {
    return this.ordered().filter(n => !n.deleted);
  }

  /**
   * Caret anchors are character ids, not offsets, so they stay correct
   * when a remote edit shifts everything around them.
   */
  anchorAt(index) {
    const vis = this.visible();
    if (index <= 0) return null;
    return vis[Math.min(index, vis.length) - 1]?.id ?? null;
  }

  /**
   * Inverse of anchorAt. If the anchor was deleted while the caret sat
   * on it, fall back to the position it used to occupy.
   */
  caretAfter(id) {
    if (id === null) return 0;
    const key = idStr(id);
    let seen = 0;
    for (const n of this.ordered()) {
      if (idStr(n.id) === key) return n.deleted ? seen : seen + 1;
      if (!n.deleted) seen++;
    }
    return seen;
  }

  render() {
    return this.visible().map(n => n.char).join('');
  }
}