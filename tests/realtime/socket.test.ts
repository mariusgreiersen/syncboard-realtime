import { randomUUID } from 'node:crypto';
import type { TaskCreatedEvent, TaskMutationResult, TaskMutationSuccess } from '@syncboard/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiClient,
  connectSocket,
  connectedSocket,
  createBoardFixture,
  eventually,
  joinBoard,
  nextEvent,
  recordEvents,
  registerUser,
  sqlQuery,
  startServer,
  truncateAll,
  waitForConnect,
  type BoardFixture,
  type ClientSocket,
  type TestServer,
} from '../helpers/harness.js';

let server: TestServer;
let fx: BoardFixture;
const sockets: ClientSocket[] = [];

const track = (socket: ClientSocket) => {
  sockets.push(socket);
  return socket;
};

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await truncateAll();
  fx = await createBoardFixture(server.url);
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});

const create = (socket: ClientSocket, title: string, extra: Record<string, unknown> = {}) =>
  socket.timeout(5_000).emitWithAck('task:create', { mutationId: randomUUID(), boardId: fx.board.id, columnId: fx.column('To Do'), title, ...extra });

function expectSuccess(result: TaskMutationResult): asserts result is TaskMutationSuccess {
  if (!result.success) throw new Error(`expected success, got ${result.code}: ${result.message}`);
}

describe('connection and authentication', () => {
  it('connects with a valid session cookie', async () => {
    const socket = track(connectSocket(server.url, fx.alice));
    await waitForConnect(socket);
    expect(socket.connected).toBe(true);
  });

  it('rejects connections without a session, with a forged cookie, or from a foreign origin', async () => {
    const anonymous = track(connectSocket(server.url, new ApiClient(server.url)));
    await expect(waitForConnect(anonymous)).rejects.toThrow('UNAUTHORIZED');

    const forged = new ApiClient(server.url);
    forged.cookie = 'sb_session=forged-token-value';
    await expect(waitForConnect(track(connectSocket(server.url, forged)))).rejects.toThrow('UNAUTHORIZED');

    const foreign = track(connectSocket(server.url, fx.alice, { origin: 'https://evil.example' }));
    await expect(waitForConnect(foreign)).rejects.toThrow();
  });

  it('disconnects live sockets when their session logs out', async () => {
    const socket = track(await connectedSocket(server.url, fx.alice));
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    await fx.alice.post('/api/v1/auth/logout');
    expect(await disconnected).toBe('io server disconnect');
  });
});

describe('board rooms', () => {
  it('joins an authorised board and receives the authoritative snapshot', async () => {
    const socket = track(await connectedSocket(server.url, fx.bob));
    const snapshot = await joinBoard(socket, fx.board.id);
    expect(snapshot.board.id).toBe(fx.board.id);
    expect(snapshot.columns).toHaveLength(4);
    expect(snapshot.revision).toBe(1);
  });

  it('rejects joining a board the user is not a member of, and never delivers its events', async () => {
    const mallory = await registerUser(server.url, 'Mallory');
    const malloryTask = track(await connectedSocket(server.url, mallory));
    const ack = await malloryTask.timeout(5_000).emitWithAck('board:join', { boardId: fx.board.id });
    expect(ack).toMatchObject({ success: false, code: 'BOARD_NOT_FOUND' });

    const leaked = recordEvents(malloryTask, ['task:created', 'board:snapshot', 'presence:updated']);
    const alice = track(await connectedSocket(server.url, fx.alice));
    await joinBoard(alice, fx.board.id);
    // The broadcast is emitted before the acknowledgement, so listen first.
    const delivered = nextEvent(alice, 'task:created');
    expectSuccess(await create(alice, 'Private description', { description: 'secret' }));
    await delivered;
    expect(leaked).toEqual([]);
  });

  it('validates join payloads', async () => {
    const socket = track(await connectedSocket(server.url, fx.alice));
    expect(await socket.timeout(5_000).emitWithAck('board:join', { boardId: 'not-a-uuid' })).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('stops delivering events after board:leave', async () => {
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bob, fx.board.id);
    await bob.timeout(5_000).emitWithAck('board:leave', { boardId: fx.board.id });
    const received = recordEvents(bob, ['task:created']);
    const alice = track(await connectedSocket(server.url, fx.alice));
    await joinBoard(alice, fx.board.id);
    const delivered = nextEvent(alice, 'task:created');
    expectSuccess(await create(alice, 'After leave'));
    await delivered;
    expect(received).toEqual([]);
  });
});

describe('mutations and broadcasts', () => {
  it('broadcasts a created task to other clients only after it is committed', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(alice, fx.board.id);
    await joinBoard(bob, fx.board.id);

    const received = nextEvent(bob, 'task:created');
    const ack = await create(alice, 'Implement authentication');
    expectSuccess(ack);
    const event = await received;
    expect(event).toMatchObject({ type: 'task:created', revision: ack.revision, mutationId: ack.mutationId, actorId: fx.alice.user.id });
    expect(event.task.title).toBe('Implement authentication');
    // Committed before broadcast: the row is in PostgreSQL by the time Bob sees the event.
    expect(await sqlQuery('select id from tasks where id = $1', [event.task.id])).toHaveLength(1);
  });

  it('acknowledges with the committed task and associates the ack with its mutation id', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    await joinBoard(alice, fx.board.id);
    const mutationId = randomUUID();
    const taskId = randomUUID();
    const ack = await alice.timeout(5_000).emitWithAck('task:create', { mutationId, taskId, boardId: fx.board.id, columnId: fx.column('Backlog'), title: 'Client id' });
    expectSuccess(ack);
    expect(ack).toMatchObject({ mutationId, duplicate: false, task: { id: taskId, version: 1, position: 0 } });
  });

  it('broadcasts moves with the authoritative ordering of every affected column', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(alice, fx.board.id);
    await joinBoard(bob, fx.board.id);
    const a = await create(alice, 'A');
    const b = await create(alice, 'B');
    expectSuccess(a);
    expectSuccess(b);

    const moved = nextEvent(alice, 'task:moved');
    const ack = await bob.timeout(5_000).emitWithAck('task:move', { mutationId: randomUUID(), boardId: fx.board.id, taskId: a.task!.id, expectedVersion: 1, toColumnId: fx.column('In Progress'), toIndex: 0 });
    expectSuccess(ack);
    const event = await moved;
    expect(event.task).toMatchObject({ id: a.task!.id, columnId: fx.column('In Progress'), version: 2 });
    expect(event.orderings).toEqual(
      expect.arrayContaining([
        { columnId: fx.column('To Do'), taskIds: [b.task!.id] },
        { columnId: fx.column('In Progress'), taskIds: [a.task!.id] },
      ]),
    );
  });

  it('broadcasts updates and deletions', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(alice, fx.board.id);
    await joinBoard(bob, fx.board.id);
    const created = await create(alice, 'Edit me');
    expectSuccess(created);
    const taskId = created.task!.id;

    const updated = nextEvent(alice, 'task:updated');
    expectSuccess(await bob.timeout(5_000).emitWithAck('task:update', { mutationId: randomUUID(), boardId: fx.board.id, taskId, expectedVersion: 1, changes: { priority: 'urgent', description: 'Now urgent' } }));
    expect((await updated).task).toMatchObject({ priority: 'urgent', description: 'Now urgent', version: 2 });

    const deleted = nextEvent(alice, 'task:deleted');
    expectSuccess(await bob.timeout(5_000).emitWithAck('task:delete', { mutationId: randomUUID(), boardId: fx.board.id, taskId, expectedVersion: 2 }));
    expect(await deleted).toMatchObject({ type: 'task:deleted', taskId, ordering: { columnId: fx.column('To Do'), taskIds: [] } });
  });

  it('returns a structured VERSION_CONFLICT acknowledgement for stale updates', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(alice, fx.board.id);
    await joinBoard(bob, fx.board.id);
    const created = await create(alice, 'Implement login');
    expectSuccess(created);
    const taskId = created.task!.id;

    expectSuccess(await alice.timeout(5_000).emitWithAck('task:update', { mutationId: randomUUID(), boardId: fx.board.id, taskId, expectedVersion: 1, changes: { title: 'Implement OAuth login' } }));
    const mutationId = randomUUID();
    const stale = await bob.timeout(5_000).emitWithAck('task:update', { mutationId, boardId: fx.board.id, taskId, expectedVersion: 1, changes: { title: 'Implement email login' } });
    expect(stale).toMatchObject({ success: false, mutationId, code: 'VERSION_CONFLICT', currentVersion: 2, currentTask: { title: 'Implement OAuth login' } });
  });

  it('does not duplicate a task when the same mutation is delivered twice', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(alice, fx.board.id);
    await joinBoard(bob, fx.board.id);
    const bobEvents = recordEvents(bob, ['task:created']);

    const payload = { mutationId: randomUUID(), boardId: fx.board.id, columnId: fx.column('To Do'), title: 'Retry me' };
    const first = await alice.timeout(5_000).emitWithAck('task:create', payload);
    const second = await alice.timeout(5_000).emitWithAck('task:create', payload);
    expectSuccess(first);
    expectSuccess(second);
    expect(second.duplicate).toBe(true);
    expect(second.task!.id).toBe(first.task!.id);
    expect(second.revision).toBe(first.revision);

    // A follow-up event proves the room is quiet apart from the single original broadcast.
    const marker = await create(alice, 'Marker');
    expectSuccess(marker);
    await eventually(() => bobEvents.length === 2);
    expect(bobEvents.map((e) => (e.payload as TaskCreatedEvent).task.title)).toEqual(['Retry me', 'Marker']);
    expect(await sqlQuery('select id from tasks where title = $1', ['Retry me'])).toHaveLength(1);
  });

  it('re-checks membership on every mutation, not just on join', async () => {
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bob, fx.board.id);
    const revoked = nextEvent(bob, 'board:sync-required', (e) => e.reason === 'access-revoked');
    await fx.alice.delete(`/api/v1/boards/${fx.board.id}/members/${fx.bob.user.id}`);
    await revoked;

    const attempt = await create(bob, 'Sneaky');
    expect(attempt).toMatchObject({ success: false, code: 'BOARD_NOT_FOUND' });
    expect(await sqlQuery('select id from tasks')).toHaveLength(0);
  });

  it('rejects mutations for one board sent from a socket that joined another', async () => {
    const mallory = await registerUser(server.url, 'Mallory');
    const own = await mallory.post<{ board: { id: string } }>('/api/v1/boards', { name: 'Mine' });
    const socket = track(await connectedSocket(server.url, mallory));
    await joinBoard(socket, own.body.board.id);
    const attempt = await socket.timeout(5_000).emitWithAck('task:create', { mutationId: randomUUID(), boardId: fx.board.id, columnId: fx.column('To Do'), title: 'Cross-board' });
    expect(attempt).toMatchObject({ success: false, code: 'BOARD_NOT_FOUND' });
  });

  it('validates event payloads at runtime', async () => {
    const socket = track(await connectedSocket(server.url, fx.alice));
    await joinBoard(socket, fx.board.id);
    const emit = (event: string, payload: unknown) =>
      (socket.timeout(5_000).emitWithAck as unknown as (event: string, payload: unknown) => Promise<TaskMutationResult>).call(socket.timeout(5_000), event, payload);
    const mutationId = randomUUID();
    expect(await emit('task:create', { mutationId, boardId: fx.board.id, columnId: fx.column('To Do'), title: '' })).toMatchObject({ success: false, mutationId, code: 'VALIDATION_ERROR' });
    expect(await emit('task:update', { mutationId: randomUUID(), boardId: fx.board.id, taskId: randomUUID(), expectedVersion: 'one', changes: {} })).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await emit('task:move', 'not an object')).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await emit('task:create', { mutationId: randomUUID(), boardId: fx.board.id, columnId: fx.column('To Do'), title: 'x', userId: fx.bob.user.id, extra: true })).toMatchObject({ success: true });
    // Identity comes from the session, not from the payload's userId.
    const [row] = await sqlQuery<{ created_by_id: string }>('select created_by_id from tasks where title = $1', ['x']);
    expect(row!.created_by_id).toBe(fx.alice.user.id);
  });

  it('REST mutations are broadcast to socket clients through the same service', async () => {
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bob, fx.board.id);
    const received = nextEvent(bob, 'task:created');
    await fx.alice.post('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column('Done'), title: 'Via REST' });
    expect((await received).task.title).toBe('Via REST');
  });

  it('notifies the room with sync-required for column changes', async () => {
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bob, fx.board.id);
    const notice = nextEvent(bob, 'board:sync-required');
    await fx.alice.post(`/api/v1/boards/${fx.board.id}/columns`, { name: 'Review' });
    expect(await notice).toMatchObject({ reason: 'columns-changed', revision: 2, actorId: fx.alice.user.id });
  });

  it('closes the room when the board is deleted', async () => {
    const bob = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bob, fx.board.id);
    const notice = nextEvent(bob, 'board:sync-required');
    await fx.alice.delete(`/api/v1/boards/${fx.board.id}`);
    expect(await notice).toMatchObject({ reason: 'board-deleted' });
  });
});

describe('presence', () => {
  it('tracks users per board, counts tabs once, and updates on leave/disconnect', async () => {
    const alice = track(await connectedSocket(server.url, fx.alice));
    let latest = nextEvent(alice, 'presence:updated');
    await joinBoard(alice, fx.board.id);
    expect((await latest).users.map((u) => u.name)).toEqual(['Alice']);

    latest = nextEvent(alice, 'presence:updated', (p) => p.users.length === 2);
    const bobTab1 = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bobTab1, fx.board.id);
    expect((await latest).users.map((u) => [u.name, u.connections])).toEqual([
      ['Alice', 1],
      ['Bob', 1],
    ]);

    // A second tab of the same user does not add a second avatar.
    latest = nextEvent(alice, 'presence:updated', (p) => p.users.find((u) => u.name === 'Bob')?.connections === 2);
    const bobTab2 = track(await connectedSocket(server.url, fx.bob));
    await joinBoard(bobTab2, fx.board.id);
    const twoTabs = await latest;
    expect(twoTabs.users).toHaveLength(2);

    // Closing one tab keeps Bob online; closing the last removes him.
    latest = nextEvent(alice, 'presence:updated', (p) => p.users.find((u) => u.name === 'Bob')?.connections === 1);
    bobTab1.disconnect();
    expect((await latest).users).toHaveLength(2);

    latest = nextEvent(alice, 'presence:updated', (p) => p.users.length === 1);
    await bobTab2.timeout(5_000).emitWithAck('board:leave', { boardId: fx.board.id });
    expect((await latest).users.map((u) => u.name)).toEqual(['Alice']);
    expect(server.syncboard.realtime.presence.list(fx.board.id).map((u) => u.name)).toEqual(['Alice']);
  });
});
