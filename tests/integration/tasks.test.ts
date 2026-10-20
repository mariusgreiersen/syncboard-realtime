import type { ApiErrorBody, BoardSnapshot, Task, TaskMutationSuccess } from '@syncboard/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBoardFixture, registerUser, sqlQuery, startServer, truncateAll, type BoardFixture, type TestServer } from '../helpers/harness.js';

let server: TestServer;
let fx: BoardFixture;

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

async function createTask(title: string, columnName = 'To Do', extra: Record<string, unknown> = {}) {
  const response = await fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column(columnName), title, ...extra });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.task!;
}

describe('task CRUD over REST', () => {
  it('creates a task with all fields and returns the committed event', async () => {
    const response = await fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', {
      boardId: fx.board.id,
      columnId: fx.column('To Do'),
      title: '  Implement authentication  ',
      description: 'Sessions + cookies',
      priority: 'urgent',
      assigneeId: fx.bob.user.id,
      dueDate: '2026-11-01',
      labels: ['backend', 'Backend', ' security '],
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ success: true, duplicate: false, revision: fx.board.revision + 2 });
    expect(response.body.task).toMatchObject({
      title: 'Implement authentication',
      priority: 'urgent',
      assigneeId: fx.bob.user.id,
      dueDate: '2026-11-01',
      labels: ['backend', 'security'],
      position: 0,
      version: 1,
      createdById: fx.alice.user.id,
    });
    expect(response.body.event).toMatchObject({ type: 'task:created', ordering: { columnId: fx.column('To Do'), taskIds: [response.body.task!.id] } });

    const fetched = await fx.bob.get<{ task: Task }>(`/api/v1/tasks/${response.body.task!.id}`);
    expect(fetched.body.task.title).toBe('Implement authentication');
  });

  it('inserts at an index and keeps positions dense', async () => {
    const a = await createTask('A');
    const b = await createTask('B');
    const c = await createTask('C', 'To Do', { index: 1 });
    const rows = await sqlQuery<{ id: string; position: number }>('select id, position from tasks where column_id = $1 order by position', [fx.column('To Do')]);
    expect(rows).toEqual([
      { id: a.id, position: 0 },
      { id: c.id, position: 1 },
      { id: b.id, position: 2 },
    ]);
  });

  it('rejects invalid input', async () => {
    const base = { boardId: fx.board.id, columnId: fx.column('To Do') };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['empty title', { ...base, title: '   ' }],
      ['long title', { ...base, title: 'x'.repeat(201) }],
      ['bad priority', { ...base, title: 'ok', priority: 'critical' }],
      ['bad due date', { ...base, title: 'ok', dueDate: '01/11/2026' }],
      ['too many labels', { ...base, title: 'ok', labels: Array.from({ length: 9 }, (_, i) => `l${i}`) }],
      ['bad column id', { ...base, columnId: 'nope', title: 'ok' }],
    ];
    for (const [name, body] of cases) {
      const response = await fx.alice.post<ApiErrorBody>('/api/v1/tasks', body);
      expect(response.status, name).toBe(400);
      expect(response.body.code, name).toBe('VALIDATION_ERROR');
    }
    // A column of another board is "not found", not silently accepted.
    const other = await fx.alice.post<{ board: { id: string } }>('/api/v1/boards', { name: 'Other' });
    const otherSnapshot = (await fx.alice.get<BoardSnapshot>(`/api/v1/boards/${other.body.board.id}/snapshot`)).body;
    const crossBoard = await fx.alice.post<ApiErrorBody>('/api/v1/tasks', { boardId: fx.board.id, columnId: otherSnapshot.columns[0]!.id, title: 'x' });
    expect(crossBoard.status).toBe(404);
    expect(crossBoard.body.code).toBe('COLUMN_NOT_FOUND');
    // Assignees must be board members.
    const outsider = await registerUser(server.url, 'Outsider');
    const badAssignee = await fx.alice.post<ApiErrorBody>('/api/v1/tasks', { ...base, title: 'x', assigneeId: outsider.user.id });
    expect(badAssignee.status).toBe(400);
    expect(await sqlQuery('select id from tasks')).toHaveLength(0);
  });

  it('updates fields and increments the version', async () => {
    const task = await createTask('Draft');
    const response = await fx.bob.patch<TaskMutationSuccess>(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: 'Final', priority: 'high', labels: ['ready'] } });
    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({ title: 'Final', priority: 'high', labels: ['ready'], version: 2 });
    expect((await fx.bob.patch(`/api/v1/tasks/${task.id}`, { expectedVersion: 2, changes: {} })).status).toBe(400);
    expect((await fx.bob.patch(`/api/v1/tasks/${task.id}`, { expectedVersion: 2, changes: { title: '' } })).status).toBe(400);
  });

  it('returns 409 VERSION_CONFLICT with the current task for stale updates', async () => {
    const task = await createTask('Implement login');
    const alice = await fx.alice.patch(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: 'Implement OAuth login' } });
    expect(alice.status).toBe(200);

    const bob = await fx.bob.patch<ApiErrorBody>(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: 'Implement email login' } });
    expect(bob.status).toBe(409);
    expect(bob.body).toMatchObject({ success: false, code: 'VERSION_CONFLICT', currentVersion: 2 });
    expect((bob.body.currentTask as Task).title).toBe('Implement OAuth login');

    const [row] = await sqlQuery<{ title: string; version: number }>('select title, version from tasks where id = $1', [task.id]);
    expect(row).toEqual({ title: 'Implement OAuth login', version: 2 });
  });

  it('deletes a task (optionally version-checked) and closes the position gap', async () => {
    const a = await createTask('A');
    const b = await createTask('B');
    const c = await createTask('C');
    await fx.alice.patch(`/api/v1/tasks/${b.id}`, { expectedVersion: 1, changes: { title: 'B2' } });

    const stale = await fx.bob.delete<ApiErrorBody>(`/api/v1/tasks/${b.id}?expectedVersion=1`);
    expect(stale.status).toBe(409);

    const deleted = await fx.bob.delete<TaskMutationSuccess>(`/api/v1/tasks/${b.id}?expectedVersion=2`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.event).toMatchObject({ type: 'task:deleted', taskId: b.id, ordering: { taskIds: [a.id, c.id] } });
    const rows = await sqlQuery<{ id: string; position: number }>('select id, position from tasks order by position');
    expect(rows).toEqual([
      { id: a.id, position: 0 },
      { id: c.id, position: 1 },
    ]);
    expect((await fx.bob.get(`/api/v1/tasks/${b.id}`)).status).toBe(404);
  });

  it('does not let non-members read or modify tasks', async () => {
    const task = await createTask('Secret');
    const mallory = await registerUser(server.url, 'Mallory');
    expect((await mallory.get(`/api/v1/tasks/${task.id}`)).status).toBe(404);
    expect((await mallory.patch(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: 'x' } })).status).toBe(404);
    expect((await mallory.post(`/api/v1/tasks/${task.id}/move`, { expectedVersion: 1, toColumnId: fx.column('Done'), toIndex: 0 })).status).toBe(404);
    expect((await mallory.delete(`/api/v1/tasks/${task.id}`)).status).toBe(404);
    expect((await mallory.post('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column('To Do'), title: 'x' })).status).toBe(404);
  });

  it('answers a retried mutation id from the idempotency ledger instead of executing twice', async () => {
    const mutationId = randomUUID();
    const body = { boardId: fx.board.id, columnId: fx.column('To Do'), title: 'Exactly once', mutationId };
    const first = await fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', body);
    const retry = await fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: true, duplicate: true, revision: first.body.revision });
    expect(retry.body.task!.id).toBe(first.body.task!.id);
    expect(await sqlQuery('select id from tasks')).toHaveLength(1);

    // Another user cannot replay someone else's mutation id.
    const hijack = await fx.bob.post<ApiErrorBody>('/api/v1/tasks', body);
    expect(hijack.status).toBe(400);
  });
});

describe('moving tasks', () => {
  it('moves between columns and reorders within a column, renumbering densely', async () => {
    const [a, b, c] = [await createTask('A'), await createTask('B'), await createTask('C')];
    const moved = await fx.bob.post<TaskMutationSuccess>(`/api/v1/tasks/${a.id}/move`, { expectedVersion: 1, toColumnId: fx.column('In Progress'), toIndex: 0 });
    expect(moved.status).toBe(200);
    expect(moved.body.task).toMatchObject({ columnId: fx.column('In Progress'), position: 0, version: 2 });
    expect(moved.body.event).toMatchObject({
      type: 'task:moved',
      fromColumnId: fx.column('To Do'),
      orderings: expect.arrayContaining([
        { columnId: fx.column('To Do'), taskIds: [b.id, c.id] },
        { columnId: fx.column('In Progress'), taskIds: [a.id] },
      ]),
    });

    const reordered = await fx.bob.post<TaskMutationSuccess>(`/api/v1/tasks/${c.id}/move`, { expectedVersion: 1, toColumnId: fx.column('To Do'), toIndex: 0 });
    expect(reordered.body.event).toMatchObject({ orderings: [{ columnId: fx.column('To Do'), taskIds: [c.id, b.id] }] });

    const rows = await sqlQuery<{ id: string; column_id: string; position: number }>('select id, column_id, position from tasks order by column_id, position');
    const byColumn = (columnId: string) => rows.filter((r) => r.column_id === columnId).map((r) => [r.id, r.position]);
    expect(byColumn(fx.column('To Do'))).toEqual([
      [c.id, 0],
      [b.id, 1],
    ]);
    expect(byColumn(fx.column('In Progress'))).toEqual([[a.id, 0]]);
  });

  it('clamps out-of-range indexes to the end of the column', async () => {
    const a = await createTask('A');
    await createTask('B', 'Done');
    const moved = await fx.alice.post<TaskMutationSuccess>(`/api/v1/tasks/${a.id}/move`, { expectedVersion: 1, toColumnId: fx.column('Done'), toIndex: 99 });
    expect(moved.body.task!.position).toBe(1);
  });

  it('rejects a stale move and leaves the ordering untouched', async () => {
    const [a, b] = [await createTask('A'), await createTask('B')];
    await fx.alice.patch(`/api/v1/tasks/${a.id}`, { expectedVersion: 1, changes: { description: 'edited' } });
    const stale = await fx.bob.post<ApiErrorBody>(`/api/v1/tasks/${a.id}/move`, { expectedVersion: 1, toColumnId: fx.column('Done'), toIndex: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const rows = await sqlQuery<{ id: string; column_id: string; position: number }>('select id, column_id, position from tasks order by position');
    expect(rows).toEqual([
      { id: a.id, column_id: fx.column('To Do'), position: 0 },
      { id: b.id, column_id: fx.column('To Do'), position: 1 },
    ]);
  });

  it('rolls back an invalid move (target column of another board) completely', async () => {
    const a = await createTask('A');
    const before = await sqlQuery<{ revision: number }>('select revision from boards where id = $1', [fx.board.id]);
    const other = await fx.alice.post<{ board: { id: string } }>('/api/v1/boards', { name: 'Other' });
    const otherColumn = (await fx.alice.get<BoardSnapshot>(`/api/v1/boards/${other.body.board.id}/snapshot`)).body.columns[0]!.id;

    const response = await fx.alice.post<ApiErrorBody>(`/api/v1/tasks/${a.id}/move`, { expectedVersion: 1, toColumnId: otherColumn, toIndex: 0 });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('COLUMN_NOT_FOUND');
    const [row] = await sqlQuery<{ column_id: string; version: number }>('select column_id, version from tasks where id = $1', [a.id]);
    expect(row).toEqual({ column_id: fx.column('To Do'), version: 1 });
    const after = await sqlQuery<{ revision: number }>('select revision from boards where id = $1', [fx.board.id]);
    expect(after).toEqual(before); // the revision increment was rolled back too
    expect(await sqlQuery('select id from processed_mutations where kind = $1', ['task.move'])).toHaveLength(0);
  });

  it('persists the order a client sees: snapshot order equals database order', async () => {
    const ids = [];
    for (const title of ['1', '2', '3', '4', '5']) ids.push((await createTask(title)).id);
    await fx.alice.post(`/api/v1/tasks/${ids[4]}/move`, { expectedVersion: 1, toColumnId: fx.column('To Do'), toIndex: 0 });
    await fx.bob.post(`/api/v1/tasks/${ids[0]}/move`, { expectedVersion: 1, toColumnId: fx.column('To Do'), toIndex: 3 });
    const snapshot = (await fx.bob.get<BoardSnapshot>(`/api/v1/boards/${fx.board.id}/snapshot`)).body;
    const dbOrder = await sqlQuery<{ id: string }>('select id from tasks where column_id = $1 order by position', [fx.column('To Do')]);
    expect(snapshot.tasks.map((t) => t.id)).toEqual(dbOrder.map((r) => r.id));
    expect(snapshot.tasks.map((t) => t.id)).toEqual([ids[4], ids[1], ids[2], ids[0], ids[3]]);
  });
});
