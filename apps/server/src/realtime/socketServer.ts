import type { Server as HttpServer } from 'node:http';
import {
  boardRoom,
  joinBoardSchema,
  leaveBoardSchema,
  socketCreateTaskSchema,
  socketDeleteTaskSchema,
  socketMoveTaskSchema,
  socketUpdateTaskSchema,
  type BoardEvent,
  type ClientToServerEvents,
  type JoinBoardResult,
  type LeaveBoardResult,
  type MutationFailure,
  type PublicUser,
  type ServerToClientEvents,
  type TaskMutationResult,
  type TaskMutationSuccess,
} from '@syncboard/shared';
import { Server, type Socket } from 'socket.io';
import type { z } from 'zod';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { AppError } from '../lib/errors.js';
import type { Log } from '../lib/logger.js';
import { toPublicUser } from '../lib/serialize.js';
import { membershipRole } from '../modules/mutations/boardTransaction.js';
import type { BoardPublisher } from '../modules/mutations/publisher.js';
import type { Services } from '../services/container.js';
import { PresenceTracker } from './presence/presenceTracker.js';
import { TokenBucket } from './rateLimiter.js';

export interface SocketData {
  userId: string;
  sessionId: string;
  /** Epoch ms after which the session is no longer valid. */
  expiresAt: number;
  user: PublicUser;
}

export type SyncBoardServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export const SOCKET_MAX_PAYLOAD_BYTES = 64 * 1024;

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function failure(mutationId: string | null, error: unknown): MutationFailure {
  if (error instanceof AppError) {
    const result: MutationFailure = { success: false, mutationId, code: error.code, message: error.message };
    if (error.currentTask !== undefined) result.currentTask = error.currentTask;
    if (error.currentVersion !== undefined) result.currentVersion = error.currentVersion;
    return result;
  }
  return { success: false, mutationId, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' };
}

function mutationIdOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'mutationId' in raw) {
    const value = (raw as { mutationId: unknown }).mutationId;
    if (typeof value === 'string' && value.length <= 64) return value;
  }
  return null;
}

export interface RealtimeServer {
  io: SyncBoardServer;
  presence: PresenceTracker;
  close: () => Promise<void>;
}

/**
 * Socket.IO server. Responsibilities: authenticate connections from the session
 * cookie, authorise room joins against PostgreSQL, validate payloads at runtime,
 * delegate mutations to the shared service layer, and broadcast committed events.
 */
export function createRealtimeServer(httpServer: HttpServer, services: Services, baseLog: Log): RealtimeServer {
  const log = baseLog.child({ component: 'realtime' });
  const allowedOrigins = new Set(services.config.ALLOWED_ORIGINS);
  const presence = new PresenceTracker();

  const io: SyncBoardServer = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    cors: { origin: [...allowedOrigins], credentials: true },
    // Browsers do not apply CORS to WebSockets, so check the Origin of the handshake explicitly
    // (prevents cross-site WebSocket hijacking with the victim's cookie).
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || allowedOrigins.has(origin));
    },
  });

  const emitPresence = (boardId: string) => {
    io.to(boardRoom(boardId)).emit('presence:updated', { boardId, users: presence.list(boardId) });
  };

  // Identity comes only from the validated session cookie, never from event payloads.
  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
      const resolved = await services.sessions.resolve(token);
      if (!resolved) {
        next(Object.assign(new Error('UNAUTHORIZED'), { data: { code: 'UNAUTHORIZED' } }));
        return;
      }
      socket.data = {
        userId: resolved.user.id,
        sessionId: resolved.sessionId,
        expiresAt: resolved.expiresAt.getTime(),
        user: toPublicUser(resolved.user),
      };
      next();
    } catch (error) {
      log.error({ err: error }, 'socket authentication failed');
      next(Object.assign(new Error('INTERNAL_ERROR'), { data: { code: 'INTERNAL_ERROR' } }));
    }
  });

  io.on('connection', (socket: AppSocket) => {
    const { userId } = socket.data;
    const socketLog = log.child({ socketId: socket.id, userId });
    const reconnect = Boolean((socket.handshake.auth as { reconnect?: unknown } | undefined)?.reconnect);
    socketLog.info({ event: reconnect ? 'socket.reconnected' : 'socket.connected', transport: socket.conn.transport.name }, reconnect ? 'socket reconnected' : 'socket connected');

    // 40 mutations burst, 10/s sustained per socket.
    const bucket = new TokenBucket(40, 10);

    const sessionExpired = () => Date.now() >= socket.data.expiresAt;

    socket.on('board:join', async (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const respond = ack as (result: JoinBoardResult) => void;
      const parsed = joinBoardSchema.safeParse(raw);
      if (!parsed.success) return respond(failure(null, new AppError('VALIDATION_ERROR', 'Invalid board id.')));
      if (sessionExpired()) {
        respond(failure(null, new AppError('UNAUTHORIZED', 'Your session has expired.')));
        socket.disconnect(true);
        return;
      }
      const { boardId } = parsed.data;
      try {
        // A room is a delivery mechanism, not an authorisation boundary: check membership first.
        if (!(await membershipRole(services.db, boardId, userId))) {
          socketLog.warn({ event: 'board.join_rejected', boardId }, 'board join rejected');
          return respond(failure(null, new AppError('BOARD_NOT_FOUND', 'Board not found.')));
        }
        // Join before reading the snapshot so no event committed after the snapshot can be missed.
        await socket.join(boardRoom(boardId));
        const snapshot = await services.boards.getSnapshot(userId, boardId);
        respond({ success: true, boardId, revision: snapshot.revision });
        socket.emit('board:snapshot', snapshot);
        presence.join(boardId, socket.data.user, socket.id);
        emitPresence(boardId);
        socketLog.info({ event: 'board.joined', boardId, revision: snapshot.revision }, 'board joined');
      } catch (error) {
        await socket.leave(boardRoom(boardId));
        respond(failure(null, error));
      }
    });

    socket.on('board:leave', async (raw: unknown, ack: unknown) => {
      const respond = typeof ack === 'function' ? (ack as (result: LeaveBoardResult) => void) : () => undefined;
      const parsed = leaveBoardSchema.safeParse(raw);
      if (!parsed.success) return respond(failure(null, new AppError('VALIDATION_ERROR', 'Invalid board id.')));
      const { boardId } = parsed.data;
      await socket.leave(boardRoom(boardId));
      if (presence.leave(boardId, userId, socket.id)) emitPresence(boardId);
      socketLog.info({ event: 'board.left', boardId }, 'board left');
      respond({ success: true, boardId });
    });

    const onMutation = <S extends z.ZodType>(
      schema: S,
      execute: (input: z.output<S>, mutationId: string) => Promise<TaskMutationSuccess>,
    ) => {
      return async (raw: unknown, ack: unknown): Promise<void> => {
        // Mutations without an acknowledgement callback cannot report their outcome; ignore them.
        if (typeof ack !== 'function') return;
        const respond = ack as (result: TaskMutationResult) => void;
        const mutationId = mutationIdOf(raw);
        if (!bucket.tryTake()) return respond(failure(mutationId, new AppError('RATE_LIMITED', 'Too many changes at once. Please slow down.')));
        if (sessionExpired()) {
          respond(failure(mutationId, new AppError('UNAUTHORIZED', 'Your session has expired.')));
          socket.disconnect(true);
          return;
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const message = issue ? `${issue.path.join('.') || 'payload'}: ${issue.message}` : 'Invalid payload.';
          return respond(failure(mutationId, new AppError('VALIDATION_ERROR', message)));
        }
        const input = parsed.data as z.output<S> & { mutationId: string };
        try {
          // The service re-checks membership inside its transaction for every mutation.
          respond(await execute(input, input.mutationId));
        } catch (error) {
          respond(failure(mutationId, error));
        }
      };
    };

    const actor = { id: userId };
    socket.on('task:create', onMutation(socketCreateTaskSchema, ({ mutationId: _m, ...input }, mutationId) => services.tasks.createTask(actor, input, mutationId)));
    socket.on('task:update', onMutation(socketUpdateTaskSchema, ({ mutationId: _m, ...input }, mutationId) => services.tasks.updateTask(actor, input, mutationId)));
    socket.on('task:move', onMutation(socketMoveTaskSchema, ({ mutationId: _m, ...input }, mutationId) => services.tasks.moveTask(actor, input, mutationId)));
    socket.on('task:delete', onMutation(socketDeleteTaskSchema, ({ mutationId: _m, ...input }, mutationId) => services.tasks.deleteTask(actor, input, mutationId)));

    socket.on('disconnect', (reason) => {
      for (const boardId of presence.leaveAll(userId, socket.id)) emitPresence(boardId);
      socketLog.info({ event: 'socket.disconnected', reason }, 'socket disconnected');
    });
  });

  const publisher: BoardPublisher = {
    publish(event: BoardEvent) {
      const room = io.to(boardRoom(event.boardId));
      switch (event.type) {
        case 'task:created':
          room.emit('task:created', event);
          break;
        case 'task:updated':
          room.emit('task:updated', event);
          break;
        case 'task:moved':
          room.emit('task:moved', event);
          break;
        case 'task:deleted':
          room.emit('task:deleted', event);
          break;
        case 'board:sync-required':
          room.emit('board:sync-required', event);
          break;
      }
    },
    revokeAccess(boardId, revokedUserId) {
      const room = boardRoom(boardId);
      for (const socketId of io.sockets.adapter.rooms.get(room) ?? []) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket || socket.data.userId !== revokedUserId) continue;
        socket.emit('board:sync-required', { type: 'board:sync-required', boardId, revision: null, reason: 'access-revoked', actorId: null });
        void socket.leave(room);
        presence.leave(boardId, revokedUserId, socketId);
      }
      emitPresence(boardId);
    },
    closeBoard(boardId, actorId) {
      const room = boardRoom(boardId);
      io.to(room).emit('board:sync-required', { type: 'board:sync-required', boardId, revision: null, reason: 'board-deleted', actorId });
      io.in(room).socketsLeave(room);
      presence.clearBoard(boardId);
    },
  };
  services.publisher.attach(publisher);

  services.realtime.disconnectSession = (sessionId: string) => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionId === sessionId) socket.disconnect(true);
    }
  };

  return {
    io,
    presence,
    close: async () => {
      // Close only the transports (io.close() would also close Fastify's HTTP server). Clients see
      // "transport close" and reconnect automatically once a server is back; a server-initiated
      // disconnect (disconnectSockets) would instead tell them not to reconnect.
      io.engine.close();
    },
  };
}
