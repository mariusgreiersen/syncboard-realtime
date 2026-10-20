import { describe, expect, it } from 'vitest';
import { applyPending, emptySync, fromSnapshot, hasGap, receiveEvent, receiveSnapshot } from './engine';
import { DOING, TODO, events, snapshot, task } from './fixtures';

describe('snapshot intake', () => {
  it('builds ordered columns from a snapshot', () => {
    const state = fromSnapshot(snapshot());
    expect(state.columnTaskIds).toEqual({ [TODO]: ['a', 'b', 'c'], [DOING]: ['d'] });
    expect(state.revision).toBe(10);
  });

  it('ignores a snapshot older than the confirmed state', () => {
    const { sync } = receiveSnapshot(emptySync(), snapshot(10));
    const stale = receiveSnapshot(sync, snapshot(9, []));
    expect(stale.outcome).toBe('stale');
    expect(stale.sync).toBe(sync);
  });
});

describe('event intake', () => {
  const start = () => receiveSnapshot(emptySync(), snapshot(10)).sync;

  it('applies the next revision', () => {
    const { sync, outcome } = receiveEvent(start(), events.updated(11, task('a', TODO, 0, { title: 'Renamed', version: 2 })));
    expect(outcome).toBe('applied');
    expect(sync.confirmed!.tasks.a!.title).toBe('Renamed');
    expect(sync.confirmed!.revision).toBe(11);
  });

  it('drops duplicates and stale events (never overwriting newer confirmed data)', () => {
    let { sync } = receiveEvent(start(), events.updated(11, task('a', TODO, 0, { title: 'New', version: 2 })));
    const replay = receiveEvent(sync, events.updated(11, task('a', TODO, 0, { title: 'New', version: 2 })));
    expect(replay.outcome).toBe('duplicate');
    const old = receiveEvent(replay.sync, events.updated(9, task('a', TODO, 0, { title: 'Ancient', version: 1 })));
    expect(old.outcome).toBe('duplicate');
    sync = old.sync;
    expect(sync.confirmed!.tasks.a!.title).toBe('New');
  });

  it('buffers out-of-order events and applies them once the gap is filled', () => {
    const later = receiveEvent(start(), events.updated(12, task('b', TODO, 1, { title: 'B2', version: 2 })));
    expect(later.outcome).toBe('buffered');
    expect(hasGap(later.sync)).toBe(true);
    expect(later.sync.confirmed!.revision).toBe(10);

    const filled = receiveEvent(later.sync, events.updated(11, task('a', TODO, 0, { title: 'A2', version: 2 })));
    expect(filled.outcome).toBe('applied');
    expect(filled.sync.confirmed!.revision).toBe(12);
    expect(filled.sync.confirmed!.tasks.b!.title).toBe('B2');
    expect(hasGap(filled.sync)).toBe(false);
  });

  it('a snapshot resolves a gap and keeps only newer buffered events', () => {
    let { sync } = receiveEvent(start(), events.updated(12, task('b', TODO, 1, { title: 'B2', version: 2 })));
    ({ sync } = receiveEvent(sync, events.updated(14, task('c', TODO, 2, { title: 'C2', version: 2 }))));
    const resolved = receiveSnapshot(sync, snapshot(13, [task('a', TODO, 0), task('b', TODO, 1, { title: 'B2', version: 2 }), task('c', TODO, 2)]));
    expect(resolved.sync.confirmed!.revision).toBe(14);
    expect(resolved.sync.confirmed!.tasks.c!.title).toBe('C2');
    expect(hasGap(resolved.sync)).toBe(false);
  });

  it('applies moves using the authoritative orderings', () => {
    const moved = task('a', DOING, 0, { version: 2 });
    const { sync } = receiveEvent(start(), events.moved(11, moved, TODO, { [TODO]: ['b', 'c'], [DOING]: ['a', 'd'] }));
    expect(sync.confirmed!.columnTaskIds).toEqual({ [TODO]: ['b', 'c'], [DOING]: ['a', 'd'] });
  });

  it('sync-required requests a snapshot', () => {
    const result = receiveEvent(start(), { type: 'board:sync-required', boardId: 'x', revision: 11, reason: 'columns-changed', actorId: null });
    expect(result.outcome).toBe('resync');
    expect(result.sync.needsSnapshot).toBe(true);
    const after = receiveSnapshot(result.sync, snapshot(11));
    expect(after.sync.needsSnapshot).toBe(false);
  });
});

describe('optimistic layer', () => {
  it('applies pending mutations on top of confirmed state without mutating it', () => {
    const confirmed = fromSnapshot(snapshot());
    const view = applyPending(confirmed, [
      { kind: 'move', mutationId: 'm1', taskId: 'a', toColumnId: DOING, toIndex: 1 },
      { kind: 'update', mutationId: 'm2', taskId: 'b', changes: { priority: 'urgent' } },
      { kind: 'create', mutationId: 'm3', task: task('new', TODO, 0), index: 0 },
      { kind: 'delete', mutationId: 'm4', taskId: 'c' },
    ]);
    expect(view.columnTaskIds).toEqual({ [TODO]: ['new', 'b'], [DOING]: ['d', 'a'] });
    expect(view.tasks.b!.priority).toBe('urgent');
    expect(view.tasks.c).toBeUndefined();
    expect(confirmed.columnTaskIds[TODO]).toEqual(['a', 'b', 'c']);
    // Unchanged tasks keep their identity (cheap re-renders).
    expect(view.tasks.d).toBe(confirmed.tasks.d);
  });

  it('is idempotent once the server has confirmed the change', () => {
    const confirmed = fromSnapshot(snapshot(11, [task('b', TODO, 0), task('c', TODO, 1), task('a', DOING, 0), task('d', DOING, 1)]));
    const view = applyPending(confirmed, [{ kind: 'move', mutationId: 'm1', taskId: 'a', toColumnId: DOING, toIndex: 0 }]);
    expect(view.columnTaskIds).toEqual(confirmed.columnTaskIds);
  });

  it('ignores mutations whose targets no longer exist', () => {
    const confirmed = fromSnapshot(snapshot());
    const view = applyPending(confirmed, [
      { kind: 'move', mutationId: 'm1', taskId: 'ghost', toColumnId: DOING, toIndex: 0 },
      { kind: 'create', mutationId: 'm2', task: task('x', 'deleted-column', 0), index: 0 },
    ]);
    expect(view.columnTaskIds).toEqual(confirmed.columnTaskIds);
  });
});
