import { randomUUID } from 'node:crypto';
import {
  idSchema,
  restCreateTaskSchema,
  restDeleteTaskQuerySchema,
  restMoveTaskSchema,
  restUpdateTaskSchema,
} from '@syncboard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../../lib/errors.js';
import type { Services } from '../../services/container.js';
import { auth, requireAuth } from '../http.js';

const taskParams = z.object({ id: idSchema });

/**
 * REST transport for task mutations. Calls the same TaskService as the Socket.IO
 * handlers, so committed REST changes are broadcast to the board room as well.
 * Stale writes return 409 VERSION_CONFLICT with the current task.
 */
export async function taskRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', requireAuth(services.sessions, services.config));

  app.post('/tasks', async (request, reply) => {
    const { mutationId, ...input } = parseOrThrow(restCreateTaskSchema, request.body);
    const result = await services.tasks.createTask(auth(request).user, input, mutationId ?? randomUUID());
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/tasks/:id', async (request) => {
    const { id } = parseOrThrow(taskParams, request.params);
    return { task: await services.tasks.getTask(auth(request).user.id, id) };
  });

  app.patch('/tasks/:id', async (request) => {
    const { id } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(restUpdateTaskSchema, request.body);
    const user = auth(request).user;
    const boardId = await services.tasks.boardIdOfTask(user.id, id);
    return services.tasks.updateTask(user, { boardId, taskId: id, expectedVersion: body.expectedVersion, changes: body.changes }, body.mutationId ?? randomUUID());
  });

  app.post('/tasks/:id/move', async (request) => {
    const { id } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(restMoveTaskSchema, request.body);
    const user = auth(request).user;
    const boardId = await services.tasks.boardIdOfTask(user.id, id);
    return services.tasks.moveTask(
      user,
      { boardId, taskId: id, expectedVersion: body.expectedVersion, toColumnId: body.toColumnId, toIndex: body.toIndex },
      body.mutationId ?? randomUUID(),
    );
  });

  app.delete('/tasks/:id', async (request) => {
    const { id } = parseOrThrow(taskParams, request.params);
    const { expectedVersion } = parseOrThrow(restDeleteTaskQuerySchema, request.query);
    const user = auth(request).user;
    const boardId = await services.tasks.boardIdOfTask(user.id, id);
    return services.tasks.deleteTask(user, { boardId, taskId: id, ...(expectedVersion ? { expectedVersion } : {}) });
  });
}
