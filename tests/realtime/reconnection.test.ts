import type { BoardSnapshot } from '@syncboard/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardSession } from '../../apps/client/src/sync/boardSession.js';
import type { BoardState } from '../../apps/client/src/sync/engine.js';
import {
  connectSocket,
  createBoardFixture,
  eventually,
  sqlQuery,
  startServer,
  truncateAll,
  waitForConnect,
  type ApiClient,
  type BoardFixture,
  type ClientSocket,
  type TestServer,
} from '../helpers/harness.js';

/*
 * End-to-end recovery tests with the real client synchronisation code (BoardSession +
 * BoardSyncController) running against the real server, real sockets and real PostgreSQL.
 */

let server: TestServer;
let fx: BoardFixture;
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  await truncateAll();
  server = await startServer();
  fx = await createBoardFixture(server.url);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await server.stop();
});

function openClient(client: ApiClient, options: { reconnection?: boolean } = {}) {
  const socket: ClientSocket = connectSocket(server.url, client, options);
  const session = new BoardSession(socket as never, fx.board.id, {
    userId: client.user!.id,
    ackTimeoutMs: 2_000,
    gapTimeoutMs: 300,
    fetchSnapshot: async (boardId) => {
      const response = await client.get<BoardSnapshot>(`/api/v1/boards/${boardId}/snapshot`);
      if (response.status !== 200) throw Object.assign(new Error('snapshot failed'), { status: response.status });
      return response.body;
    },
  });
  session.start();
  cleanups.push(() => {
    session.stop();
    socket.disconnect();
  });
  return { socket, session, view: () => session.controller.getState().view };
}

/** Normalised view: column order with task ids, and the fields of every task. */
function shape(view: BoardState | null) {
  if (!view) return null;
  return {
    revision: view.revision,
    columns: view.columns.map((column) => ({ name: column.name, taskIds: view.columnTaskIds[column.id] ?? [] })),
    tasks: Object.values(view.tasks)
      .map((t) => ({ id: t.id, title: t.title, description: t.description, columnId: t.columnId, version: t.version }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function databaseShape(boardId: string) {
  const [board] = await sqlQuery<{ revision: number }>('select revision from boards where id = $1', [boardId]);
  const columns = await sqlQuery<{ id: string; name: string }>('select id, name from columns where board_id = $1 order by position', [boardId]);
  const tasks = await sqlQuery<{ id: string; title: string; description: string; column_id: string; version: number; position: number }>(
    'select id, title, description, column_id, version, position from tasks where board_id = $1 order by position',
    [boardId],
  );
  return {
    revision: board!.revision,
    columns: columns.map((c) => ({ name: c.name, taskIds: tasks.filter((t) => t.column_id === c.id).map((t) => t.id) })),
    tasks: tasks
      .map((t) => ({ id: t.id, title: t.title, description: t.description, columnId: t.column_id, version: t.version }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const synced = (session: BoardSession) => eventually(() => session.getPhase() === 'synced' && session.controller.getState().view !== null);

describe('reconnection and state recovery', () => {
  it('a client that was offline while another client created, moved and edited tasks converges after reconnecting', async () => {
    const alice = openClient(fx.alice);
    const bob = openClient(fx.bob);
    await Promise.all([synced(alice.session), synced(bob.session)]);

    // Seed two tasks while both are online.
    const first = await bob.session.controller.createTask({ columnId: fx.column('To Do'), title: 'Move me' });
    const second = await bob.session.controller.createTask({ columnId: fx.column('To Do'), title: 'Edit me' });
    expect(first.ok && second.ok).toBe(true);
    await eventually(() => Object.keys(alice.view()?.tasks ?? {}).length === 2);

    // 1. Alice goes offline.
    alice.socket.disconnect();
    expect(alice.socket.connected).toBe(false);
    // Offline clients refuse new persistent mutations instead of pretending to save them.
    const refused = await alice.session.controller.createTask({ columnId: fx.column('To Do'), title: 'Offline' });
    expect(refused).toMatchObject({ ok: false, code: 'DISCONNECTED' });

    // 2. Bob creates, moves and edits while Alice is away.
    const created = await bob.session.controller.createTask({ columnId: fx.column('Backlog'), title: 'Created while Alice was offline' });
    const moved = await bob.session.controller.moveTask(first.ok ? first.task!.id : '', fx.column('In Progress'), 0);
    const edited = await bob.session.controller.updateTask(second.ok ? second.task!.id : '', { description: 'Edited while Alice was offline' });
    expect([created.ok, moved.ok, edited.ok]).toEqual([true, true, true]);
    expect(shape(alice.view())).not.toEqual(shape(bob.view()));

    // 3. Alice reconnects: rejoin → authoritative snapshot → reconcile. No page refresh involved.
    alice.socket.connect();
    await waitForConnect(alice.socket);
    await eventually(() => alice.view()?.revision === bob.view()?.revision);

    // 4. Both clients and PostgreSQL agree.
    expect(shape(alice.view())).toEqual(shape(bob.view()));
    expect(shape(alice.view())).toEqual(await databaseShape(fx.board.id));
    expect(alice.view()!.tasks[first.ok ? first.task!.id : '']!.columnId).toBe(fx.column('In Progress'));
  });

  it('a mutation in flight when the connection drops is resent with the same id and applied exactly once', async () => {
    const alice = openClient(fx.alice);
    const bob = openClient(fx.bob);
    await Promise.all([synced(alice.session), synced(bob.session)]);

    const outcome = alice.session.controller.createTask({ columnId: fx.column('To Do'), title: 'Exactly once' });
    alice.socket.disconnect(); // drop before the acknowledgement can arrive
    expect(alice.view()!.columnTaskIds[fx.column('To Do')]).toHaveLength(1); // optimistic copy stays visible

    alice.socket.connect();
    const result = await outcome;
    expect(result.ok).toBe(true);
    await eventually(() => alice.session.controller.getState().pending.length === 0 && alice.view()?.revision === bob.view()?.revision);

    expect(await sqlQuery('select id from tasks where title = $1', ['Exactly once'])).toHaveLength(1);
    expect(shape(alice.view())).toEqual(shape(bob.view()));
    expect(shape(bob.view())).toEqual(await databaseShape(fx.board.id));
  });

  it('survives a server restart: sockets reconnect automatically, re-authenticate, and resynchronise', async () => {
    const alice = openClient(fx.alice, { reconnection: true });
    const bob = openClient(fx.bob, { reconnection: true });
    await Promise.all([synced(alice.session), synced(bob.session)]);
    const before = await bob.session.controller.createTask({ columnId: fx.column('To Do'), title: 'Before restart' });
    expect(before.ok).toBe(true);

    const port = server.port;
    await server.stop();
    await eventually(() => !alice.socket.connected && !bob.socket.connected);

    server = await startServer({ port });
    await eventually(() => alice.socket.connected && bob.socket.connected, 10_000);
    await Promise.all([synced(alice.session), synced(bob.session)]);

    const after = await alice.session.controller.createTask({ columnId: fx.column('Done'), title: 'After restart' });
    expect(after.ok).toBe(true);
    await eventually(() => Object.values(bob.view()?.tasks ?? {}).some((t) => t.title === 'After restart'));
    expect(shape(alice.view())).toEqual(shape(bob.view()));
    expect(shape(alice.view())).toEqual(await databaseShape(fx.board.id));
  });

  it('a rejected optimistic change reconciles to the collaborator\'s committed state instead of an old local copy', async () => {
    const alice = openClient(fx.alice);
    const bob = openClient(fx.bob);
    await Promise.all([synced(alice.session), synced(bob.session)]);
    const created = await alice.session.controller.createTask({ columnId: fx.column('To Do'), title: 'Implement login' });
    const taskId = created.ok ? created.task!.id : '';
    await eventually(() => Boolean(bob.view()?.tasks[taskId]));

    // Both opened the editor at version 1. Alice saves first.
    expect((await alice.session.controller.updateTask(taskId, { title: 'Implement OAuth login' }, 1)).ok).toBe(true);
    const bobResult = await bob.session.controller.updateTask(taskId, { title: 'Implement email login' }, 1);
    expect(bobResult).toMatchObject({ ok: false, code: 'VERSION_CONFLICT', currentTask: { title: 'Implement OAuth login', version: 2 } });

    // Bob's view shows Alice's committed title, not his rejected one and not the pre-edit title.
    await eventually(() => bob.view()?.tasks[taskId]?.title === 'Implement OAuth login');
    expect(bob.session.controller.getState().stats.conflicts).toBe(1);
    expect(shape(bob.view())).toEqual(shape(alice.view()));
  });
});
