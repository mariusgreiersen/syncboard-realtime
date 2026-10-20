import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AckTimeoutError, BoardSyncController, type SyncNotice } from './controller';
import { BOARD_ID, DOING, FakeTransport, TODO, USER, events, snapshot, success, task } from './fixtures';

let transport: FakeTransport;
let notices: SyncNotice[];
let snapshotRequests: string[];
let counter: number;

function makeController() {
  const controller = new BoardSyncController(
    BOARD_ID,
    transport,
    { requestSnapshot: (reason) => snapshotRequests.push(reason), notify: (notice) => notices.push(notice) },
    { userId: USER, ackTimeoutMs: 1_000, gapTimeoutMs: 500, maxAttempts: 3, generateId: () => `id-${++counter}` },
  );
  controller.receiveSnapshot(snapshot(10));
  return controller;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const order = (c: BoardSyncController, column: string) => c.getState().view!.columnTaskIds[column];

beforeEach(() => {
  transport = new FakeTransport();
  notices = [];
  snapshotRequests = [];
  counter = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('optimistic mutations', () => {
  it('shows a move immediately and keeps it after the server confirms', async () => {
    const c = makeController();
    const outcome = c.moveTask('a', DOING, 0);
    expect(order(c, DOING)).toEqual(['a', 'd']);
    expect(transport.last().payload).toMatchObject({ taskId: 'a', expectedVersion: 1, toColumnId: DOING, toIndex: 0 });

    const event = events.moved(11, task('a', DOING, 0, { version: 2 }), TODO, { [TODO]: ['b', 'c'], [DOING]: ['a', 'd'] }, transport.last().payload.mutationId as string);
    transport.last().resolve(success(event, task('a', DOING, 0, { version: 2 })));
    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(c.getState().pending).toEqual([]);
    expect(order(c, DOING)).toEqual(['a', 'd']);
    expect(c.getState().view!.revision).toBe(11);
  });

  it('a broadcast carrying our mutation id confirms it even before the acknowledgement', async () => {
    const c = makeController();
    const outcome = c.createTask({ columnId: TODO, title: 'New', index: 0 });
    const sent = transport.last().payload;
    const created = task(sent.taskId as string, TODO, 0, { title: 'New' });
    c.receiveEvent(events.created(11, created, [created.id, 'a', 'b', 'c'], sent.mutationId as string));
    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(c.getState().pending).toEqual([]);
    // The late acknowledgement is harmless.
    transport.last().resolve(success(events.created(11, created, [created.id, 'a', 'b', 'c'], sent.mutationId as string), created));
    await flush();
    expect(order(c, TODO)).toEqual([created.id, 'a', 'b', 'c']);
    expect(c.getState().view!.revision).toBe(11);
  });

  it('a rejected mutation falls back to the latest confirmed state, keeping collaborators\' changes', async () => {
    const c = makeController();
    const outcome = c.moveTask('a', DOING, 0);
    // Meanwhile Bob's committed edits of other tasks arrive.
    c.receiveEvent(events.updated(11, task('b', TODO, 1, { title: 'Bob renamed B', version: 2 })));
    c.receiveEvent(events.updated(12, task('a', TODO, 0, { description: 'Bob edited A', version: 2 })));
    expect(order(c, DOING)).toEqual(['a', 'd']); // still optimistic

    transport.last().resolve({ success: false, mutationId: transport.last().payload.mutationId as string, code: 'VERSION_CONFLICT', message: 'x', currentTask: task('a', TODO, 0, { version: 2 }) });
    const result = await outcome;
    expect(result).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });

    const view = c.getState().view!;
    expect(view.columnTaskIds).toEqual({ [TODO]: ['a', 'b', 'c'], [DOING]: ['d'] });
    expect(view.tasks.b!.title).toBe('Bob renamed B');
    expect(view.tasks.a!.description).toBe('Bob edited A');
    expect(notices).toEqual([expect.objectContaining({ type: 'conflict', message: 'This task was changed by another collaborator. The board has been refreshed.' })]);
    expect(snapshotRequests).toEqual(['mutation-version_conflict']);
    expect(c.getState().stats.conflicts).toBe(1);
  });

  it('uses the version observed when the editor was opened', () => {
    const c = makeController();
    void c.updateTask('a', { title: 'x' }, 7);
    expect(transport.last().payload).toMatchObject({ expectedVersion: 7 });
  });

  it('refuses new mutations while offline instead of pretending to save them', async () => {
    const c = makeController();
    transport.connected = false;
    await expect(c.moveTask('a', DOING, 0)).resolves.toMatchObject({ ok: false, code: 'DISCONNECTED' });
    expect(transport.sent).toHaveLength(0);
    expect(order(c, DOING)).toEqual(['d']);
    expect(notices[0]!.type).toBe('offline');
  });
});

describe('chaining mutations of the same task', () => {
  it('sends the second mutation only after the first, with the version the server returned', async () => {
    const c = makeController();
    const move = c.moveTask('a', DOING, 0);
    const update = c.updateTask('a', { title: 'Renamed' });
    expect(transport.sent).toHaveLength(1);
    expect(c.getState().pending.map((p) => p.status)).toEqual(['in-flight', 'queued']);
    // Both are visible optimistically.
    expect(c.getState().view!.tasks.a).toMatchObject({ columnId: DOING, title: 'Renamed' });

    const moved = task('a', DOING, 0, { version: 2 });
    transport.sent[0]!.resolve(success(events.moved(11, moved, TODO, { [TODO]: ['b', 'c'], [DOING]: ['a', 'd'] }, transport.sent[0]!.payload.mutationId as string), moved));
    await move;
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.payload).toMatchObject({ taskId: 'a', expectedVersion: 2, changes: { title: 'Renamed' } });

    const renamed = task('a', DOING, 0, { version: 3, title: 'Renamed' });
    transport.sent[1]!.resolve(success(events.updated(12, renamed, transport.sent[1]!.payload.mutationId as string), renamed));
    await expect(update).resolves.toMatchObject({ ok: true });
    expect(c.getState().pending).toEqual([]);
  });

  it('drops queued dependants when the first mutation is rejected', async () => {
    const c = makeController();
    const move = c.moveTask('a', DOING, 0);
    const update = c.updateTask('a', { title: 'Renamed' });
    transport.sent[0]!.resolve({ success: false, mutationId: transport.sent[0]!.payload.mutationId as string, code: 'VERSION_CONFLICT', message: 'x' });
    await move;
    await expect(update).resolves.toMatchObject({ ok: false });
    expect(transport.sent).toHaveLength(1);
    expect(c.getState().view!.tasks.a).toMatchObject({ columnId: TODO, title: 'A' });
  });
});

describe('ordering, gaps and resynchronisation', () => {
  it('requests a snapshot when a missing revision does not arrive in time', () => {
    vi.useFakeTimers();
    const c = makeController();
    c.receiveEvent(events.updated(12, task('b', TODO, 1, { version: 2 })));
    expect(c.getState().view!.revision).toBe(10);
    expect(snapshotRequests).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(snapshotRequests).toEqual(['revision-gap']);
    expect(c.getState().stats.gapsDetected).toBe(1);
  });

  it('does not resync if the missing event arrives within the grace period', () => {
    vi.useFakeTimers();
    const c = makeController();
    c.receiveEvent(events.updated(12, task('b', TODO, 1, { version: 2 })));
    c.receiveEvent(events.updated(11, task('a', TODO, 0, { version: 2 })));
    vi.advanceTimersByTime(1_000);
    expect(snapshotRequests).toEqual([]);
    expect(c.getState().view!.revision).toBe(12);
  });

  it('ignores stale snapshots', () => {
    const c = makeController();
    c.receiveEvent(events.updated(11, task('a', TODO, 0, { title: 'Newer', version: 2 })));
    c.receiveSnapshot(snapshot(10));
    expect(c.getState().view!.tasks.a!.title).toBe('Newer');
    expect(c.getState().stats.staleSnapshotsIgnored).toBe(1);
  });

  it('requests a snapshot on board:sync-required', () => {
    const c = makeController();
    c.receiveEvent({ type: 'board:sync-required', boardId: BOARD_ID, revision: 11, reason: 'columns-changed', actorId: 'user-bob' });
    expect(snapshotRequests).toEqual(['sync-required']);
  });
});

describe('timeouts and reconnection', () => {
  it('retries a timed-out mutation with the same mutation id', async () => {
    const c = makeController();
    const outcome = c.moveTask('a', DOING, 0);
    const first = transport.sent[0]!;
    first.reject(new AckTimeoutError());
    await flush();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.payload.mutationId).toBe(first.payload.mutationId);
    expect(transport.sent[1]!.payload.expectedVersion).toBe(1);

    const moved = task('a', DOING, 0, { version: 2 });
    transport.sent[1]!.resolve({ ...success(events.moved(11, moved, TODO, { [TODO]: ['b', 'c'], [DOING]: ['a', 'd'] }, first.payload.mutationId as string), moved), duplicate: true });
    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(c.getState().stats.retries).toBe(1);
  });

  it('gives up after the maximum attempts, tells the user and resynchronises', async () => {
    const c = makeController();
    const outcome = c.moveTask('a', DOING, 0);
    for (let i = 0; i < 3; i++) {
      transport.sent[i]!.reject(new AckTimeoutError());
      await flush();
    }
    await expect(outcome).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(order(c, DOING)).toEqual(['d']);
    expect(notices.at(-1)!.type).toBe('timeout');
    expect(snapshotRequests).toContain('mutation-timeout');
  });

  it('parks in-flight mutations on disconnect and resends them with the same id after the reconnect snapshot', async () => {
    const c = makeController();
    const outcome = c.createTask({ columnId: TODO, title: 'Written before the drop' });
    const original = transport.sent[0]!;
    transport.connected = false;
    c.handleDisconnect();
    expect(c.getState().pending[0]!.status).toBe('awaiting-reconnect');
    expect(order(c, TODO)).toHaveLength(4); // still visible, marked as pending

    // The old acknowledgement can no longer arrive; a late rejection from the old connection is ignored.
    original.reject(new AckTimeoutError());
    await flush();
    expect(transport.sent).toHaveLength(1);

    transport.connected = true;
    c.receiveSnapshot(snapshot(12));
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.payload.mutationId).toBe(original.payload.mutationId);
    expect(transport.sent[1]!.payload.taskId).toBe(original.payload.taskId);

    const created = task(original.payload.taskId as string, TODO, 3, { title: 'Written before the drop' });
    transport.sent[1]!.resolve(success(events.created(13, created, ['a', 'b', 'c', created.id], original.payload.mutationId as string), created));
    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(c.getState().view!.revision).toBe(13);
  });
});
