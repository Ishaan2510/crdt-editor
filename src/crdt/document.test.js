import { describe, it, expect } from 'vitest';
import { Doc } from './document.js';
import { insertAt, deleteAt, deliver } from './ops.js';

describe('local editing', () => {
  it('starts empty', () => {
    expect(new Doc('a').render()).toBe('');
  });

  it('appends characters', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'Hello');
    expect(d.render()).toBe('Hello');
  });

  it('inserts at the start', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'World');
    insertAt(d, 0, 'Hello ');
    expect(d.render()).toBe('Hello World');
  });

  it('inserts in the middle', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'Hell World');
    insertAt(d, 4, 'o');
    expect(d.render()).toBe('Hello World');
  });

  it('deletes a range', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'Hello World');
    deleteAt(d, 5, 6);
    expect(d.render()).toBe('Hello');
  });

  it('keeps tombstones so deleted text can still be a parent', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'ab');
    deleteAt(d, 0, 2);
    expect(d.render()).toBe('');
    expect(d.nodes.size).toBe(2);
  });
});

describe('causal delivery', () => {
  it('buffers an insert whose parent has not arrived', () => {
    const a = new Doc('a');
    const ops = insertAt(a, 0, 'abc');

    const b = new Doc('b');
    deliver(b, [ops[2]]);          // 'c' first
    expect(b.render()).toBe('');
    expect(b.pending.length).toBe(1);

    deliver(b, [ops[1]]);          // 'b'
    expect(b.render()).toBe('');

    deliver(b, [ops[0]]);          // 'a' unblocks the whole chain
    expect(b.render()).toBe('abc');
    expect(b.pending.length).toBe(0);
  });

  it('buffers a delete whose target has not arrived', () => {
    const a = new Doc('a');
    const ins = insertAt(a, 0, 'x');
    const del = deleteAt(a, 0, 1);

    const b = new Doc('b');
    deliver(b, [...del, ...ins]);  // delete before insert
    expect(b.render()).toBe('');
    expect(b.nodes.size).toBe(1);
  });

  it('ignores re-delivered operations', () => {
    const a = new Doc('a');
    const ins = insertAt(a, 0, 'hi');
    const del = deleteAt(a, 0, 1);

    const b = new Doc('b');
    deliver(b, [...ins, ...del]);
    const once = b.render();

    deliver(b, [...ins, ...del, ...ins]);
    expect(b.render()).toBe(once);
    expect(b.nodes.size).toBe(2);
  });
});