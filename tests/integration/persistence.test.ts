import type { BoardSnapshot, TaskMutationSuccess } from '@syncboard/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, createBoardFixture, registerUser, startServer, truncateAll, type TestServer } from '../helpers/harness.js';

let server: TestServer;

beforeEach(async () => {
  await truncateAll();
  server = await startServer();
});
afterEach(async () => {
  await server.stop();
});

describe('persistence across server restarts', () => {
  it('boards, tasks, task order, sessions and permissions survive a restart', async () => {
    const fx = await createBoardFixture(server.url);
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      const response = await fx.alice.post<TaskMutationSuccess>('/api/v1/tasks', { boardId: fx.board.id, columnId: fx.column('To Do'), title });
      ids.push(response.body.task!.id);
    }
    await fx.bob.post(`/api/v1/tasks/${ids[2]}/move`, { expectedVersion: 1, toColumnId: fx.column('To Do'), toIndex: 0 });
    await fx.bob.post(`/api/v1/tasks/${ids[0]}/move`, { expectedVersion: 1, toColumnId: fx.column('Done'), toIndex: 0 });
    const mallory = await registerUser(server.url, 'Mallory');
    const before = (await fx.alice.get<BoardSnapshot>(`/api/v1/boards/${fx.board.id}/snapshot`)).body;

    // Restart: a brand-new process state (no in-memory data survives), same database and port.
    const port = server.port;
    await server.stop();
    server = await startServer({ port });

    const after = (await fx.bob.get<BoardSnapshot>(`/api/v1/boards/${fx.board.id}/snapshot`)).body; // Bob's session cookie still works
    expect({ ...after, generatedAt: '' }).toEqual({ ...before, generatedAt: '' });
    expect(after.tasks.filter((t) => t.columnId === fx.column('To Do')).map((t) => t.id)).toEqual([ids[2], ids[1]]);
    expect(after.tasks.filter((t) => t.columnId === fx.column('Done')).map((t) => t.id)).toEqual([ids[0]]);

    expect((await mallory.get(`/api/v1/boards/${fx.board.id}/snapshot`)).status).toBe(404);
    expect((await fx.bob.patch(`/api/v1/boards/${fx.board.id}`, { name: 'x' })).status).toBe(403);
    expect((await fx.alice.patch(`/api/v1/boards/${fx.board.id}`, { name: 'Renamed after restart' })).status).toBe(200);

    // Logging in again also works against the restarted server.
    const relogin = new ApiClient(server.url);
    expect((await relogin.post('/api/v1/auth/login', { email: fx.alice.user.email, password: 'correct horse battery' })).status).toBe(200);
  });
});
