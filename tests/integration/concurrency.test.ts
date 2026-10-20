import { randomUUID } from 'node:crypto';
import type { ApiErrorBody, Task, TaskMutationSuccess } from '@syncboard/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBoardFixture, sqlQuery, startServer, truncateAll, type BoardFixture, type Response, type TestServer } from '../helpers/harness.js';

/*
 * These tests issue genuinely concurrent HTTP requests (Promise.all over separate
 * connections from the server's pool) against real PostgreSQL. They assert outcomes
 * that a naive read-then-write implementation would violate.
 */

let server: TestServer;
let fx: BoardFixture;

beforeAll(async () => {
  server = await startServer({ config: { DATABASE_POOL_MAX: 20 } });
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await truncateAll();
  fx = await createBoardFixture(server.url);
});

async function createTask(title: string, columnName = 'To Do'): Promise<Task> {
  const response = await fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column(columnName), title });
  return response.body.task!;
}

/** Every column's positions must be exactly 0..n-1 (dense, unique) and every task must be present once. */
async function assertOrderingInvariants(expectedTaskCount: number) {
  const rows = await sqlQuery<{ column_id: string; position: number }>('select column_id, position from tasks where board_id = $1 order by column_id, position', [fx.board.id]);
  expect(rows).toHaveLength(expectedTaskCount);
  const byColumn = new Map<string, number[]>();
  for (const row of rows) byColumn.set(row.column_id, [...(byColumn.get(row.column_id) ?? []), row.position]);
  for (const positions of byColumn.values()) {
    expect(positions).toEqual(positions.map((_, index) => index));
  }
}

const ok = (r: Response<unknown>) => r.status >= 200 && r.status < 300;

describe('optimistic concurrency control', () => {
  it('two competing updates based on the same version cannot both succeed', async () => {
    const task = await createTask('Implement login');
    const [alice, bob] = await Promise.all([
      fx.alice.patch<TaskMutationSuccess | ApiErrorBody>(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: 'Implement OAuth login' } }),
      fx.bob.patch<TaskMutationSuccess | ApiErrorBody>(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: 'Implement email login' } }),
    ]);
    const statuses = [alice.status, bob.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = alice.status === 200 ? 'Implement OAuth login' : 'Implement email login';
    const loser = (alice.status === 409 ? alice : bob).body as ApiErrorBody;
    expect(loser.code).toBe('VERSION_CONFLICT');
    expect((loser.currentTask as Task).title).toBe(winner);
    const [row] = await sqlQuery<{ title: string; version: number }>('select title, version from tasks where id = $1', [task.id]);
    expect(row).toEqual({ title: winner, version: 2 });
  });

  it('with 12 concurrent writers on one version, exactly one wins', async () => {
    const task = await createTask('Contended');
    const clients = [fx.alice, fx.bob];
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => clients[i % 2]!.patch(`/api/v1/tasks/${task.id}`, { expectedVersion: 1, changes: { title: `Writer ${i}` } })),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(11);
    const [row] = await sqlQuery<{ version: number }>('select version from tasks where id = $1', [task.id]);
    expect(row!.version).toBe(2);
  });
});

describe('concurrent drag-and-drop ordering', () => {
  it('two users moving different tasks into the same column concurrently both succeed with a consistent order', async () => {
    const a = await createTask('A', 'Backlog');
    const b = await createTask('B', 'To Do');
    const existing = await createTask('Existing', 'In Progress');
    const [moveA, moveB] = await Promise.all([
      fx.alice.post<TaskMutationSuccess>(`/api/v1/tasks/${a.id}/move`, { expectedVersion: 1, toColumnId: fx.column('In Progress'), toIndex: 0 }),
      fx.bob.post<TaskMutationSuccess>(`/api/v1/tasks/${b.id}/move`, { expectedVersion: 1, toColumnId: fx.column('In Progress'), toIndex: 0 }),
    ]);
    expect(moveA.status).toBe(200);
    expect(moveB.status).toBe(200);
    // The serialised order is: whichever committed second is first in the column.
    const [first, second] = moveA.body.revision < moveB.body.revision ? [a, b] : [b, a];
    const rows = await sqlQuery<{ id: string }>('select id from tasks where column_id = $1 order by position', [fx.column('In Progress')]);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id, existing.id]);
    // The later event's ordering is the final authoritative ordering.
    const later = moveA.body.revision > moveB.body.revision ? moveA.body : moveB.body;
    const finalOrdering = (later.event as Extract<typeof later.event, { type: 'task:moved' }>).orderings.find((o) => o.columnId === fx.column('In Progress'));
    expect(finalOrdering?.taskIds).toEqual(rows.map((r) => r.id));
    await assertOrderingInvariants(3);
  });

  it('two users moving the same task concurrently: one succeeds, the other gets a conflict', async () => {
    const task = await createTask('Contested');
    const [alice, bob] = await Promise.all([
      fx.alice.post(`/api/v1/tasks/${task.id}/move`, { expectedVersion: 1, toColumnId: fx.column('In Progress'), toIndex: 0 }),
      fx.bob.post(`/api/v1/tasks/${task.id}/move`, { expectedVersion: 1, toColumnId: fx.column('Done'), toIndex: 0 }),
    ]);
    expect([alice.status, bob.status].sort()).toEqual([200, 409]);
    const expectedColumn = alice.status === 200 ? fx.column('In Progress') : fx.column('Done');
    const [row] = await sqlQuery<{ column_id: string; version: number; position: number }>('select column_id, version, position from tasks where id = $1', [task.id]);
    expect(row).toEqual({ column_id: expectedColumn, version: 2, position: 0 });
  });

  it('20 concurrent creates into one column produce positions 0..19', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? fx.alice : fx.bob).post('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column('Backlog'), title: `Task ${i}`, index: 0 }),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    await assertOrderingInvariants(20);
  });

  it('a randomised burst of concurrent moves, creates, edits and deletes keeps every invariant', async () => {
    const columnNames = ['Backlog', 'To Do', 'In Progress', 'Done'];
    const tasks: Task[] = [];
    for (let i = 0; i < 12; i++) tasks.push(await createTask(`Seed ${i}`, columnNames[i % 4]));
    const [{ revision: startRevision }] = (await sqlQuery<{ revision: number }>('select revision from boards where id = $1', [fx.board.id])) as [{ revision: number }];

    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!;

    const operations = Array.from({ length: 60 }, (_, i) => {
      const client = i % 2 ? fx.alice : fx.bob;
      const task = pick(tasks);
      const roll = random();
      if (roll < 0.6) {
        return client.post(`/api/v1/tasks/${task.id}/move`, { expectedVersion: task.version, toColumnId: fx.column(pick(columnNames)), toIndex: Math.floor(random() * 6) });
      }
      if (roll < 0.75) return client.patch(`/api/v1/tasks/${task.id}`, { expectedVersion: task.version, changes: { title: `Edited ${i}` } });
      if (roll < 0.9) return client.post('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column(pick(columnNames)), title: `New ${i}`, index: Math.floor(random() * 4) });
      return client.delete(`/api/v1/tasks/${task.id}`);
    });
    const responses = await Promise.all(operations);

    // Only expected outcomes: success, version conflict, or "already deleted".
    for (const response of responses) expect([200, 201, 404, 409]).toContain(response.status);
    expect(responses.some((r) => r.status === 409)).toBe(true);

    const successes = responses.filter(ok) as Array<Response<TaskMutationSuccess>>;
    const [{ count }] = (await sqlQuery<{ count: number }>('select count(*)::int as count from tasks where board_id = $1', [fx.board.id])) as [{ count: number }];
    await assertOrderingInvariants(count);

    // Every successful mutation got a distinct revision, and together they are contiguous:
    // the board lock serialised them into one total order.
    const revisions = successes.map((r) => r.body.revision).sort((x, y) => x - y);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions).toEqual(revisions.map((_, i) => startRevision + 1 + i));
    const [{ revision: endRevision }] = (await sqlQuery<{ revision: number }>('select revision from boards where id = $1', [fx.board.id])) as [{ revision: number }];
    expect(endRevision).toBe(startRevision + successes.length);

    // Failed mutations left no activity rows behind.
    const activity = await sqlQuery<{ count: number }>('select count(*)::int as count from activity_events where board_id = $1 and revision > $2', [fx.board.id, startRevision]);
    expect(activity[0]!.count).toBe(successes.length);
  });
});

describe('idempotent retries', () => {
  it('a retry racing its original executes exactly once', async () => {
    const mutationId = randomUUID();
    const body = { boardId: fx.board.id, columnId: fx.column('To Do'), title: 'Once', mutationId };
    const responses = await Promise.all(Array.from({ length: 5 }, () => fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', body)));
    expect(responses.every(ok)).toBe(true);
    expect(responses.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.task!.id)).size).toBe(1);
    expect(await sqlQuery('select id from tasks')).toHaveLength(1);
  });
});
