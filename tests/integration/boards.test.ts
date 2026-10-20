import type { ActivityEvent, Board, BoardMember, BoardSnapshot, BoardSummary, Column, User } from '@syncboard/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_BOARD_ID } from '../../apps/server/src/modules/demo/demoData.js';
import { ApiClient, createBoardFixture, registerUser, sqlQuery, startServer, truncateAll, type TestServer } from '../helpers/harness.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await truncateAll();
});

describe('boards', () => {
  it('creates a board with the four default columns and lists it', async () => {
    const alice = await registerUser(server.url, 'Alice');
    const created = await alice.post<{ board: BoardSummary }>('/api/v1/boards', { name: 'Roadmap', description: 'Q3', accent: 'violet' });
    expect(created.status).toBe(201);
    expect(created.body.board).toMatchObject({ name: 'Roadmap', description: 'Q3', accent: 'violet', role: 'owner', revision: 0, ownerId: alice.user.id });

    const snapshot = (await alice.get<BoardSnapshot>(`/api/v1/boards/${created.body.board.id}/snapshot`)).body;
    expect(snapshot.columns.map((c) => c.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'Done']);
    expect(snapshot.columns.map((c) => c.position)).toEqual([0, 1, 2, 3]);
    expect(snapshot.members).toHaveLength(1);

    const list = await alice.get<{ boards: BoardSummary[] }>('/api/v1/boards');
    expect(list.body.boards).toHaveLength(1);
    expect(list.body.boards[0]).toMatchObject({ taskCount: 0, memberCount: 1 });
  });

  it('validates board input', async () => {
    const alice = await registerUser(server.url, 'Alice');
    expect((await alice.post('/api/v1/boards', { name: '   ' })).status).toBe(400);
    expect((await alice.post('/api/v1/boards', { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await alice.post('/api/v1/boards', { name: 'Ok', accent: 'neon' })).status).toBe(400);
    expect((await alice.get('/api/v1/boards/not-a-uuid')).status).toBe(400);
  });

  it('hides private boards from non-members (404, no existence leak)', async () => {
    const { board } = await createBoardFixture(server.url);
    const mallory = await registerUser(server.url, 'Mallory');
    for (const path of [`/api/v1/boards/${board.id}`, `/api/v1/boards/${board.id}/snapshot`, `/api/v1/boards/${board.id}/members`, `/api/v1/boards/${board.id}/activity`]) {
      const response = await mallory.get<{ code: string }>(path);
      expect(response.status, path).toBe(404);
      expect(response.body.code).toBe('BOARD_NOT_FOUND');
    }
    expect((await mallory.patch(`/api/v1/boards/${board.id}`, { name: 'Pwned' })).status).toBe(404);
    expect((await mallory.delete(`/api/v1/boards/${board.id}`)).status).toBe(404);
    expect((await mallory.post(`/api/v1/boards/${board.id}/columns`, { name: 'Pwned' })).status).toBe(404);
    expect((await mallory.get<{ boards: unknown[] }>('/api/v1/boards')).body.boards).toHaveLength(0);
  });

  it('lets only the owner edit and delete the board', async () => {
    const { alice, bob, board } = await createBoardFixture(server.url);
    const denied = await bob.patch<{ code: string }>(`/api/v1/boards/${board.id}`, { name: 'Bob was here' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect((await bob.delete(`/api/v1/boards/${board.id}`)).status).toBe(403);

    const updated = await alice.patch<{ board: Board }>(`/api/v1/boards/${board.id}`, { name: 'Launch v2' });
    expect(updated.status).toBe(200);
    expect(updated.body.board.name).toBe('Launch v2');
    expect(updated.body.board.revision).toBe(board.revision + 2); // +1 for adding Bob, +1 for the rename

    expect((await alice.delete(`/api/v1/boards/${board.id}`)).status).toBe(204);
    expect((await alice.get(`/api/v1/boards/${board.id}`)).status).toBe(404);
    // Cascades leave no orphans.
    expect(await sqlQuery('select id from columns where board_id = $1', [board.id])).toHaveLength(0);
    expect(await sqlQuery('select id from board_members where board_id = $1', [board.id])).toHaveLength(0);
  });

  it('adds and removes members; removal unassigns tasks and revokes access', async () => {
    const { alice, bob, board, column } = await createBoardFixture(server.url);
    const members = await bob.get<{ members: BoardMember[] }>(`/api/v1/boards/${board.id}/members`);
    expect(members.body.members.map((m) => m.role).sort()).toEqual(['member', 'owner']);

    expect((await alice.post(`/api/v1/boards/${board.id}/members`, { email: bob.user.email })).status).toBe(409);
    expect((await alice.post(`/api/v1/boards/${board.id}/members`, { email: 'ghost@example.com' })).status).toBe(404);
    const carol = await registerUser(server.url, 'Carol');
    expect((await bob.post(`/api/v1/boards/${board.id}/members`, { email: carol.user.email })).status).toBe(403);

    const task = await alice.post<{ task: { id: string } }>('/api/v1/tasks', { boardId: board.id, columnId: column('To Do'), title: 'Bob task', assigneeId: bob.user.id });
    expect(task.status).toBe(201);

    expect((await alice.delete(`/api/v1/boards/${board.id}/members/${bob.user.id}`)).status).toBe(204);
    expect((await bob.get(`/api/v1/boards/${board.id}/snapshot`)).status).toBe(404);
    const [row] = await sqlQuery<{ assignee_id: string | null; version: number }>('select assignee_id, version from tasks where id = $1', [task.body.task.id]);
    expect(row).toEqual({ assignee_id: null, version: 2 });

    // The owner cannot be removed, but a member can leave.
    expect((await alice.delete(`/api/v1/boards/${board.id}/members/${alice.user.id}`)).status).toBe(403);
    await alice.post(`/api/v1/boards/${board.id}/members`, { email: carol.user.email });
    expect((await carol.delete(`/api/v1/boards/${board.id}/members/${carol.user.id}`)).status).toBe(204);
  });

  it('adds and renames columns', async () => {
    const { bob, board, column } = await createBoardFixture(server.url);
    const created = await bob.post<{ column: Column }>(`/api/v1/boards/${board.id}/columns`, { name: 'Review' });
    expect(created.status).toBe(201);
    expect(created.body.column.position).toBe(4);

    const renamed = await bob.patch<{ column: Column }>(`/api/v1/columns/${column('Backlog')}`, { name: 'Ideas' });
    expect(renamed.body.column.name).toBe('Ideas');
    expect((await bob.patch(`/api/v1/columns/${column('Backlog')}`, { name: '' })).status).toBe(400);

    const snapshot = (await bob.get<BoardSnapshot>(`/api/v1/boards/${board.id}/snapshot`)).body;
    expect(snapshot.columns.map((c) => c.name)).toEqual(['Ideas', 'To Do', 'In Progress', 'Done', 'Review']);
  });

  it('records activity in the same transaction as each change', async () => {
    const { alice, board, column } = await createBoardFixture(server.url);
    const created = await alice.post<{ task: { id: string; version: number } }>('/api/v1/tasks', { boardId: board.id, columnId: column('To Do'), title: 'Ship it' });
    await alice.post(`/api/v1/tasks/${created.body.task.id}/move`, { expectedVersion: 1, toColumnId: column('Done'), toIndex: 0 });
    // A rejected (stale) move must not leave an activity row behind.
    await alice.post(`/api/v1/tasks/${created.body.task.id}/move`, { expectedVersion: 1, toColumnId: column('To Do'), toIndex: 0 });

    const activity = (await alice.get<{ activity: ActivityEvent[] }>(`/api/v1/boards/${board.id}/activity`)).body.activity;
    expect(activity.map((a) => a.actionType)).toEqual(['task.moved', 'task.created', 'member.added']);
    expect(activity[0]!.payload).toMatchObject({ title: 'Ship it', from: 'To Do', to: 'Done' });
    expect(activity[0]!.actor?.name).toBe('Alice');
  });
});

describe('demo mode', () => {
  it('signs in as a seeded persona and keeps demo and regular accounts apart', async () => {
    await server.syncboard.services.demo.ensureDemoData();
    const alice = new ApiClient(server.url);
    const login = await alice.post<{ user: User }>('/api/v1/auth/demo', { persona: 'alice' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ name: 'Alice Andersen', isDemo: true });

    const boards = (await alice.get<{ boards: BoardSummary[] }>('/api/v1/boards')).body.boards;
    expect(boards.map((b) => b.id)).toEqual([DEMO_BOARD_ID]);
    const snapshot = (await alice.get<BoardSnapshot>(`/api/v1/boards/${DEMO_BOARD_ID}/snapshot`)).body;
    expect(snapshot.tasks.length).toBeGreaterThanOrEqual(15);
    expect(snapshot.members.map((m) => m.name).sort()).toEqual(['Alice Andersen', 'Bob Nielsen', 'Charlie Holm']);

    // A regular user cannot be added to the demo board, and a demo user cannot join a private board.
    const regular = await registerUser(server.url, 'Real');
    const addReal = await alice.post(`/api/v1/boards/${DEMO_BOARD_ID}/members`, { email: regular.user.email });
    expect(addReal.status).toBe(403);
    const privateBoard = await regular.post<{ board: Board }>('/api/v1/boards', { name: 'Private' });
    const addDemo = await regular.post(`/api/v1/boards/${privateBoard.body.board.id}/members`, { email: 'alice@syncboard.test' });
    expect(addDemo.status).toBe(403);
    expect((await alice.get(`/api/v1/boards/${privateBoard.body.board.id}/snapshot`)).status).toBe(404);
  });

  it('resets the demo board as a single new revision', async () => {
    await server.syncboard.services.demo.ensureDemoData();
    const bob = new ApiClient(server.url);
    await bob.post('/api/v1/auth/demo', { persona: 'bob' });
    const before = (await bob.get<BoardSnapshot>(`/api/v1/boards/${DEMO_BOARD_ID}/snapshot`)).body;
    await bob.request('DELETE', `/api/v1/tasks/${before.tasks[0]!.id}`);

    await server.syncboard.services.demo.resetDemo();
    const after = (await bob.get<BoardSnapshot>(`/api/v1/boards/${DEMO_BOARD_ID}/snapshot`)).body;
    expect(after.tasks).toHaveLength(before.tasks.length);
    expect(after.revision).toBe(before.revision + 2); // delete, then reset
  });

  it('can be disabled', async () => {
    const locked = await startServer({ config: { DEMO_MODE: false } });
    try {
      const response = await new ApiClient(locked.url).post('/api/v1/auth/demo', { persona: 'alice' });
      expect(response.status).toBe(404);
    } finally {
      await locked.stop();
    }
  });
});
