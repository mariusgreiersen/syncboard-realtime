import {
  activityQuerySchema,
  addMemberSchema,
  createBoardSchema,
  createColumnSchema,
  idSchema,
  updateBoardSchema,
  updateColumnSchema,
} from '@syncboard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../../lib/errors.js';
import type { Services } from '../../services/container.js';
import { auth, requireAuth } from '../http.js';

const boardParams = z.object({ id: idSchema });
const memberParams = z.object({ id: idSchema, userId: idSchema });

export async function boardRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', requireAuth(services.sessions, services.config));

  app.get('/boards', async (request) => ({ boards: await services.boards.listBoards(auth(request).user.id) }));

  app.post('/boards', async (request, reply) => {
    const input = parseOrThrow(createBoardSchema, request.body);
    return reply.status(201).send({ board: await services.boards.createBoard(auth(request).user, input) });
  });

  app.get('/boards/:id', async (request) => {
    const { id } = parseOrThrow(boardParams, request.params);
    return { board: await services.boards.getBoard(auth(request).user.id, id) };
  });

  app.patch('/boards/:id', async (request) => {
    const { id } = parseOrThrow(boardParams, request.params);
    const changes = parseOrThrow(updateBoardSchema, request.body);
    return { board: await services.boards.updateBoard(auth(request).user, id, changes) };
  });

  app.delete('/boards/:id', async (request, reply) => {
    const { id } = parseOrThrow(boardParams, request.params);
    await services.boards.deleteBoard(auth(request).user, id);
    return reply.status(204).send();
  });

  /** Authoritative state used for initial load and for reconciliation after reconnects or missed events. */
  app.get('/boards/:id/snapshot', async (request, reply) => {
    const { id } = parseOrThrow(boardParams, request.params);
    reply.header('cache-control', 'no-store');
    return services.boards.getSnapshot(auth(request).user.id, id);
  });

  app.get('/boards/:id/activity', async (request) => {
    const { id } = parseOrThrow(boardParams, request.params);
    const { limit } = parseOrThrow(activityQuerySchema, request.query);
    return { activity: await services.activity.list(auth(request).user.id, id, limit) };
  });

  app.get('/boards/:id/members', async (request) => {
    const { id } = parseOrThrow(boardParams, request.params);
    return { members: await services.members.list(auth(request).user.id, id) };
  });

  app.post('/boards/:id/members', async (request, reply) => {
    const { id } = parseOrThrow(boardParams, request.params);
    const { email } = parseOrThrow(addMemberSchema, request.body);
    return reply.status(201).send({ member: await services.members.add(auth(request).user, id, email) });
  });

  app.delete('/boards/:id/members/:userId', async (request, reply) => {
    const { id, userId } = parseOrThrow(memberParams, request.params);
    await services.members.remove(auth(request).user, id, userId);
    return reply.status(204).send();
  });

  app.post('/boards/:id/columns', async (request, reply) => {
    const { id } = parseOrThrow(boardParams, request.params);
    const { name } = parseOrThrow(createColumnSchema, request.body);
    return reply.status(201).send({ column: await services.columns.create(auth(request).user, id, name) });
  });

  app.patch('/columns/:id', async (request) => {
    const { id } = parseOrThrow(boardParams, request.params);
    const { name } = parseOrThrow(updateColumnSchema, request.body);
    return { column: await services.columns.rename(auth(request).user, id, name) };
  });
}
