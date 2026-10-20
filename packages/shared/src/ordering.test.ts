import { describe, expect, it } from 'vitest';
import { clampIndex, computeMove, insertAt, positionChanges, visibleIndexToFullIndex } from './ordering.js';

describe('clampIndex / insertAt', () => {
  it('clamps to the valid range', () => {
    expect(clampIndex(-3, 4)).toBe(0);
    expect(clampIndex(2.7, 4)).toBe(2);
    expect(clampIndex(99, 4)).toBe(4);
    expect(clampIndex(Number.NaN, 4)).toBe(0);
  });

  it('inserts without duplicating an existing id', () => {
    expect(insertAt(['a', 'b', 'c'], 'x', 1)).toEqual(['a', 'x', 'b', 'c']);
    expect(insertAt(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(insertAt([], 'x', 5)).toEqual(['x']);
  });
});

describe('computeMove', () => {
  const lists = { todo: ['a', 'b', 'c'], doing: ['d'] };

  it('moves across columns and returns both changed columns', () => {
    expect(computeMove(lists, 'b', 'todo', 'doing', 0)).toEqual({ todo: ['a', 'c'], doing: ['b', 'd'] });
  });

  it('reorders within a column; the index refers to the list without the moved task', () => {
    expect(computeMove(lists, 'a', 'todo', 'todo', 2)).toEqual({ todo: ['b', 'c', 'a'] });
    expect(computeMove(lists, 'c', 'todo', 'todo', 0)).toEqual({ todo: ['c', 'a', 'b'] });
  });

  it('appends when moving into an empty or unknown column', () => {
    expect(computeMove(lists, 'd', 'doing', 'done', 3)).toEqual({ doing: [], done: ['d'] });
  });
});

describe('visibleIndexToFullIndex (drag-and-drop while filtered)', () => {
  // Full column: a b c d e ; filter shows only b and d.
  const full = ['a', 'b', 'c', 'd', 'e'];
  const visible = ['b', 'd'];

  it('dropping first places the task directly before the first visible card', () => {
    expect(visibleIndexToFullIndex(full, visible, 0)).toBe(1);
  });

  it('dropping between visible cards places it right after the card above', () => {
    expect(visibleIndexToFullIndex(full, visible, 1)).toBe(2);
    expect(visibleIndexToFullIndex(full, visible, 2)).toBe(4);
  });

  it('dropping into a column whose cards are all hidden appends at the end', () => {
    expect(visibleIndexToFullIndex(full, [], 0)).toBe(5);
  });

  it('never changes the relative order of hidden cards', () => {
    for (let index = 0; index <= visible.length; index++) {
      const result = insertAt(full, 'x', visibleIndexToFullIndex(full, visible, index));
      expect(result.filter((id) => id !== 'x')).toEqual(full);
    }
  });
});

describe('positionChanges', () => {
  it('returns only rows whose position differs', () => {
    const current = [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ];
    expect(positionChanges(current, ['a', 'c', 'b'])).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
    expect(positionChanges(current, ['a', 'b', 'c'])).toEqual([]);
  });
});
