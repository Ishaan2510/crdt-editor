import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Doc } from './document.js';
import { insertAt, deleteAt, deliver } from './ops.js';

/** Deterministic PRNG so any failing case is reproducible from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const step = fc.record({
  replica: fc.nat({ max: 2 }),
  action: fc.constantFrom('insert', 'insert', 'delete'),
  pos: fc.nat({ max: 30 }),
  char: fc.constantFrom(...'abcde \n'.split(''))
});

describe('property: replicas converge under arbitrary delivery', () => {
  it('three replicas edit blind, then agree after full exchange', () => {
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (script, seed) => {
          const sites = ['s1', 's2', 's3'];
          const docs = sites.map(s => new Doc(s));
          const log = sites.map(() => []);

          // Phase 1: every replica edits without seeing the others.
          for (const s of script) {
            const d = docs[s.replica];
            const len = d.visible().length;
            if (s.action === 'insert') {
              log[s.replica].push(...insertAt(d, s.pos % (len + 1), s.char));
            } else if (len > 0) {
              log[s.replica].push(...deleteAt(d, s.pos % len, 1));
            }
          }

          // Phase 2: full exchange in a different shuffled order per replica,
          // with duplicates injected to exercise idempotence.
          const all = log.flat();
          docs.forEach((d, i) => {
            const rand = mulberry32(seed + i * 7919);
            const noisy = shuffle([...all, ...shuffle(all, rand).slice(0, 5)], rand);
            deliver(d, noisy);
          });

          const rendered = docs.map(d => d.render());
          const drained = docs.every(d => d.pending.length === 0);

          return drained && rendered.every(r => r === rendered[0]);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('a replica that misses operations catches up to an identical state', () => {
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (script, seed) => {
          const online = new Doc('on');
          const offline = new Doc('off');
          const log = [];

          for (const s of script) {
            const len = online.visible().length;
            if (s.action === 'insert') {
              log.push(...insertAt(online, s.pos % (len + 1), s.char));
            } else if (len > 0) {
              log.push(...deleteAt(online, s.pos % len, 1));
            }
          }

          const rand = mulberry32(seed);
          deliver(offline, shuffle(log, rand));

          return offline.render() === online.render() && offline.pending.length === 0;
        }
      ),
      { numRuns: 200 }
    );
  });
});