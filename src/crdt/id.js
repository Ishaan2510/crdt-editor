export const ROOT = 'ROOT';

/** Random per-tab identity. No coordination needed. */
export function makeSiteId() {
  return Math.random().toString(36).slice(2, 10);
}

/** Map an id to a string key. null means the root of the document. */
export function idStr(id) {
  return id === null ? ROOT : `${id.site}:${id.lamport}`;
}

/**
 * Sibling ordering. Newer inserts sit closer to the parent.
 * Site id breaks ties between concurrent inserts and carries no meaning.
 */
export function compareIds(a, b) {
  if (a.lamport !== b.lamport) return b.lamport - a.lamport;
  if (a.site < b.site) return -1;
  if (a.site > b.site) return 1;
  return 0;
}

/**
 * Fixed id for the editor's seeded newline. Every replica derives it
 * identically, so all replicas produce the same node rather than one each.
 */
export const GENESIS = { site: '\u0000genesis', lamport: 0 };

/**
 * Total order over ids, used for last-writer-wins on attributes.
 * Distinct from compareIds, which is sibling render order.
 */
export function dominates(a, b) {
  if (a.lamport !== b.lamport) return a.lamport > b.lamport;
  return a.site > b.site;
}