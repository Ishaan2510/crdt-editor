import { describe, it, expect } from 'vitest';
import { Doc } from './document.js';
import { insertAt, deleteAt, deliver } from './ops.js';

/** Two replicas holding the same starting text, not yet diverged. */
function pair(text) {
  const a = new Doc('aaaa');
  const seed = insertAt(a, 0, text);
  const b = new Doc('bbbb');
  deliver(b, seed);
  return [a, b];
}

describe('concurrent scenarios from the brief', () => {
  it('concurrent inserts at the same position both survive', () => {
    const [a, b] = pair('HO');
    const opA = insertAt(a, 1, 'X');
    const opB = insertAt(b, 1, 'Y');

    deliver(a, opB);
    deliver(b, opA);

    expect(a.render()).toBe(b.render());
    expect(a.render()).toContain('X');
    expect(a.render()).toContain('Y');
  });

  it('a typed word stays contiguous instead of interleaving', () => {
    const [a, b] = pair('H');
    const opA = insertAt(a, 1, 'abc');
    const opB = insertAt(b, 1, 'xyz');

    deliver(a, opB);
    deliver(b, opA);

    expect(a.render()).toBe(b.render());
    expect(['Habcxyz', 'Hxyzabc']).toContain(a.render());
  });

  it('concurrent deletes of the same character converge', () => {
    const [a, b] = pair('Hello');
    const opA = deleteAt(a, 1, 1);
    const opB = deleteAt(b, 1, 1);

    deliver(a, opB);
    deliver(b, opA);

    expect(a.render()).toBe('Hllo');
    expect(b.render()).toBe('Hllo');
  });

  it('an insert into a concurrently deleted range is not lost', () => {
    const [a, b] = pair('Hello');
    const del = deleteAt(a, 1, 3);   // remove "ell"
    const ins = insertAt(b, 2, 'X'); // type inside that range

    deliver(a, ins);
    deliver(b, del);

    expect(a.render()).toBe(b.render());
    expect(a.render()).toBe('HXo');
  });

  it('deletes the whole document concurrently with an insert', () => {
    const [a, b] = pair('abc');
    const del = deleteAt(a, 0, 3);
    const ins = insertAt(b, 3, 'd');

    deliver(a, ins);
    deliver(b, del);

    expect(a.render()).toBe(b.render());
    expect(a.render()).toBe('d');
  });
});

describe('algebraic properties of the merge', () => {
  it('is commutative: order of arrival does not matter', () => {
    const [a, b] = pair('base');
    const opA = insertAt(a, 4, '-A');
    const opB = insertAt(b, 0, 'B-');

    const ab = new Doc('cccc');
    deliver(ab, [...opA, ...opB]);

    const ba = new Doc('dddd');
    deliver(ba, [...opB, ...opA]);

    const seed = insertAt(new Doc('eeee'), 0, 'base');
    deliver(ab, seed);
    deliver(ba, seed);

    expect(ab.render()).toBe(ba.render());
  });

  it('is idempotent: applying twice equals applying once', () => {
    const a = new Doc('aaaa');
    const ops = [...insertAt(a, 0, 'hello'), ...deleteAt(a, 0, 2)];

    const once = new Doc('bbbb');
    deliver(once, ops);

    const twice = new Doc('cccc');
    deliver(twice, [...ops, ...ops]);

    expect(twice.render()).toBe(once.render());
    expect(twice.nodes.size).toBe(once.nodes.size);
  });

  it('is associative: grouping of merges does not matter', () => {
    const a = new Doc('aaaa');
    const b = new Doc('bbbb');
    const c = new Doc('cccc');

    const opA = insertAt(a, 0, 'AAA');
    const opB = insertAt(b, 0, 'BBB');
    const opC = insertAt(c, 0, 'CCC');

    // (A merged with B) then C
    const left = new Doc('llll');
    deliver(left, [...opA, ...opB]);
    deliver(left, opC);

    // A then (B merged with C)
    const right = new Doc('rrrr');
    deliver(right, opA);
    deliver(right, [...opB, ...opC]);

    expect(left.render()).toBe(right.render());
  });
});