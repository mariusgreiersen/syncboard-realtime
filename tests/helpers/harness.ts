import type { AddressInfo } from 'node:net';
import type {
  BoardSnapshot,
  BoardSummary,
  ClientToServerEvents,
  ServerToClientEvents,
  User,
} from '@syncboard/shared';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { buildApp, type SyncBoardApp } from '../../apps/server/src/app.js';
import { loadConfig, type AppConfig } from '../../apps/server/src/config/env.js';
import { TEST_ORIGIN, testDatabaseUrl } from './env.js';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface TestServer {
  url: string;
  port: number;
  syncboard: SyncBoardApp;
  stop: () => Promise<void>;
}

/** Starts a real Fastify + Socket.IO server against the test database. */
export async function startServer(options: { port?: number; config?: Partial<AppConfig> } = {}): Promise<TestServer> {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
      RATE_LIMIT_DISABLED: 'true',
      DEMO_MODE: 'true',
      ALLOWED_ORIGINS: TEST_ORIGIN,
    },
    options.config,
  );
  const syncboard = await buildApp(config);
  await syncboard.app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const { port } = syncboard.app.server.address() as AddressInfo;
  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    syncboard,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await syncboard.close();
    },
  };
}

const TABLES = ['activity_events', 'processed_mutations', 'tasks', 'columns', 'board_members', 'boards', 'sessions', 'users'];

export async function truncateAll(): Promise<void> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}

/** Runs a query against the test database directly (to assert on authoritative PostgreSQL state). */
export async function sqlQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

export interface Response<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** Minimal HTTP client with a cookie jar of one session cookie (the equivalent of Supertest's agent). */
export class ApiClient {
  cookie: string | null = null;
  user: User | null = null;

  constructor(readonly baseUrl: string) {}

  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response<T>> {
    const send = () =>
      fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : null,
      });
    let response: globalThis.Response;
    try {
      response = await send();
    } catch (error) {
      // After a server restart, fetch may reuse a pooled keep-alive socket of the stopped
      // server; the request never reached a server, so retrying once is safe.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== 'ECONNRESET' && code !== 'UND_ERR_SOCKET') throw error;
      response = await send();
    }
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const match = /sb_session=([^;]*)/.exec(setCookie);
      if (match) this.cookie = match[1] ? `sb_session=${match[1]}` : null;
    }
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T, headers: response.headers };
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {});
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  delete<T = unknown>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

let userCounter = 0;

export async function registerUser(baseUrl: string, name: string): Promise<ApiClient & { user: User }> {
  const client = new ApiClient(baseUrl);
  userCounter += 1;
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now()}.${userCounter}@example.com`;
  const response = await client.post<{ user: User }>('/api/v1/auth/register', { email, password: 'correct horse battery', name });
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  client.user = response.body.user;
  return client as ApiClient & { user: User };
}

export interface BoardFixture {
  alice: ApiClient & { user: User };
  bob: ApiClient & { user: User };
  board: BoardSummary;
  snapshot: BoardSnapshot;
  column: (name: string) => string;
}

/** Alice owns a fresh board with the default columns; Bob is a member. */
export async function createBoardFixture(baseUrl: string): Promise<BoardFixture> {
  const alice = await registerUser(baseUrl, 'Alice');
  const bob = await registerUser(baseUrl, 'Bob');
  const created = await alice.post<{ board: BoardSummary }>('/api/v1/boards', { name: 'Launch', description: 'Test board' });
  const board = created.body.board;
  const added = await alice.post(`/api/v1/boards/${board.id}/members`, { email: bob.user.email });
  if (added.status !== 201) throw new Error(`add member failed: ${added.status} ${JSON.stringify(added.body)}`);
  const snapshot = (await alice.get<BoardSnapshot>(`/api/v1/boards/${board.id}/snapshot`)).body;
  const column = (name: string) => {
    const found = snapshot.columns.find((c) => c.name === name);
    if (!found) throw new Error(`no column ${name}`);
    return found.id;
  };
  return { alice, bob, board, snapshot, column };
}

export function connectSocket(baseUrl: string, client: ApiClient, options: { reconnection?: boolean; origin?: string } = {}): ClientSocket {
  return io(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: options.reconnection ?? false,
    reconnectionDelay: 100,
    reconnectionDelayMax: 300,
    extraHeaders: {
      origin: options.origin ?? TEST_ORIGIN,
      ...(client.cookie ? { cookie: client.cookie } : {}),
    },
  }) as ClientSocket;
}

export function waitForConnect(socket: ClientSocket, timeoutMs = 5_000): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function connectedSocket(baseUrl: string, client: ApiClient): Promise<ClientSocket> {
  const socket = connectSocket(baseUrl, client);
  await waitForConnect(socket);
  return socket;
}

type ServerEventName = keyof ServerToClientEvents;
type ServerEventPayload<E extends ServerEventName> = Parameters<ServerToClientEvents[E]>[0];

/** Resolves with the next matching server event; rejects after `timeoutMs`. */
export function nextEvent<E extends ServerEventName>(
  socket: ClientSocket,
  event: E,
  predicate: (payload: ServerEventPayload<E>) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<ServerEventPayload<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: ServerEventPayload<E>) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler as never);
      resolve(payload);
    };
    socket.on(event, handler as never);
  });
}

/** Records every event of the given names, for asserting that something did NOT happen. */
export function recordEvents(socket: ClientSocket, events: ServerEventName[]): Array<{ event: ServerEventName; payload: unknown }> {
  const log: Array<{ event: ServerEventName; payload: unknown }> = [];
  for (const event of events) socket.on(event, ((payload: unknown) => log.push({ event, payload })) as never);
  return log;
}

export async function joinBoard(socket: ClientSocket, boardId: string): Promise<BoardSnapshot> {
  const snapshot = nextEvent(socket, 'board:snapshot', (s) => s.board.id === boardId);
  const ack = await socket.timeout(5_000).emitWithAck('board:join', { boardId });
  if (!ack.success) throw new Error(`join failed: ${ack.code}`);
  return snapshot;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns true (or throws on timeout). Used instead of fixed sleeps. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(intervalMs);
  }
}
