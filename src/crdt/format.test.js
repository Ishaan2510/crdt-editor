import { describe, it, expect } from 'vitest';
import { Doc } from './document.js';
import { insertAt, deleteAt, deliver, formatRange, formatBlock } from './ops.js';

const attrsOf = doc => doc.visible().map(n => ({ ch: n.char, ...n.attrs }));

describe('local formatting', () => {
  it('applies an attribute to a range only', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'abcd');
    formatRange(d, 1, 3, 'bold', true);
    expect(attrsOf(d)).toEqual([
      { ch: 'a' },
      { ch: 'b', bold: true },
      { ch: 'c', bold: true },
      { ch: 'd' }
    ]);
  });

  it('puts block attributes on the terminating newline', () => {
    const d = new Doc('a');
    insertAt(d, 0, 'Title\nbody');
    formatBlock(d, 0, 'heading', 1);
    const nl = d.visible().find(n => n.char === '\n');
    expect(nl.attrs.heading).toBe(1);
  });
});

describe('concurrent formatting', () => {
  it('different keys on the same characters both survive', () => {
    const a = new Doc('aaaa');
    const seed = insertAt(a, 0, 'word');
    const b = new Doc('bbbb');
    deliver(b, seed);

    const opA = formatRange(a, 0, 4, 'bold', true);
    const opB = formatRange(b, 0, 4, 'italic', true);

    deliver(a, [opB]);
    deliver(b, [opA]);

    expect(attrsOf(a)).toEqual(attrsOf(b));
    expect(a.visible()[0].attrs).toEqual({ bold: true, italic: true });
  });

  it('the same key resolves by last-writer-wins and converges', () => {
    const a = new Doc('aaaa');
    const seed = insertAt(a, 0, 'word');
    const b = new Doc('bbbb');
    deliver(b, seed);

    const opA = formatRange(a, 0, 4, 'bold', true);
    const opB = formatRange(b, 0, 4, 'bold', false);

    deliver(a, [opB]);
    deliver(b, [opA]);

    expect(attrsOf(a)).toEqual(attrsOf(b));
  });

  it('partially overlapping ranges converge', () => {
    const a = new Doc('aaaa');
    const seed = insertAt(a, 0, 'abcdef');
    const b = new Doc('bbbb');
    deliver(b, seed);

    const opA = formatRange(a, 0, 4, 'bold', true);
    const opB = formatRange(b, 2, 6, 'bold', false);

    deliver(a, [opB]);
    deliver(b, [opA]);

    expect(attrsOf(a)).toEqual(attrsOf(b));
  });

  it('formatting a concurrently deleted character does not diverge', () => {
    const a = new Doc('aaaa');
    const seed = insertAt(a, 0, 'abc');
    const b = new Doc('bbbb');
    deliver(b, seed);

    const del = deleteAt(a, 1, 1);
    const fmt = formatRange(b, 0, 3, 'bold', true);

    deliver(a, [fmt]);
    deliver(b, del);

    expect(a.render()).toBe(b.render());
    expect(attrsOf(a)).toEqual(attrsOf(b));
  });
});

describe('out-of-order and repeated formatting', () => {
  it('buffers a format op whose targets have not arrived', () => {
    const a = new Doc('aaaa');
    const ins = insertAt(a, 0, 'ab');
    const fmt = formatRange(a, 0, 2, 'bold', true);

    const b = new Doc('bbbb');
    deliver(b, [fmt]);
    expect(b.pending.length).toBe(1);

    deliver(b, ins);
    expect(b.pending.length).toBe(0);
    expect(attrsOf(b)).toEqual(attrsOf(a));
  });

  it('applies to arrived targets and waits for the rest', () => {
    const a = new Doc('aaaa');
    const ins = insertAt(a, 0, 'ab');
    const fmt = formatRange(a, 0, 2, 'bold', true);

    const b = new Doc('bbbb');
    deliver(b, [ins[0], fmt]);
    expect(b.visible()[0].attrs.bold).toBe(true);
    expect(b.pending.length).toBe(1);

    deliver(b, [ins[1]]);
    expect(attrsOf(b)).toEqual(attrsOf(a));
  });

  it('re-delivering a format op changes nothing', () => {
    const a = new Doc('aaaa');
    const ops = [...insertAt(a, 0, 'ab'), formatRange(a, 0, 2, 'bold', true)];

    const b = new Doc('bbbb');
    deliver(b, ops);
    const once = attrsOf(b);

    deliver(b, [...ops, ...ops]);
    expect(attrsOf(b)).toEqual(once);
  });

  it('an older op cannot overwrite a newer one on redelivery', () => {
    const a = new Doc('aaaa');
    const seed = insertAt(a, 0, 'x');
    const b = new Doc('bbbb');
    deliver(b, seed);

    const early = formatRange(a, 0, 1, 'bold', true);
    deliver(b, [early]);
    const late = formatRange(b, 0, 1, 'bold', false);

    deliver(b, [early]);
    expect(b.visible()[0].attrs.bold).toBe(false);
    expect(b.visible()[0].attrClocks.bold).toEqual(late.id);
  });
});

describe('seeded genesis newline', () => {
  it('renders a single trailing newline', () => {
    const d = new Doc('a', { seed: true });
    expect(d.render()).toBe('\n');
  });

  it('is identical across replicas rather than one per site', () => {
    const a = new Doc('aaaa', { seed: true });
    const b = new Doc('bbbb', { seed: true });

    const ops = insertAt(a, 0, 'hi');
    deliver(b, ops);

    expect(b.render()).toBe('hi\n');
    expect(b.nodes.size).toBe(3);
  });

  it('keeps the terminator last as text is typed', () => {
    const d = new Doc('a', { seed: true });
    insertAt(d, 0, 'abc');
    expect(d.render()).toBe('abc\n');
  });
});