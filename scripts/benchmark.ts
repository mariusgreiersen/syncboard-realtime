/**
 * Measures acknowledgement and broadcast-propagation latency of task updates.
 *
 *   npm run benchmark -- --url http://localhost:3001 --clients 1,10,50 --ops 100
 *
 * One writer socket sends `task:update` mutations (paced below the per-socket rate limit);
 * N reader sockets on the same board record when each committed `task:updated` arrives.
 * All clients run in this process, so send and receive times share one clock.
 * Results depend entirely on the machine; the script prints its environment.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { BoardSnapshot, BoardSummary, ClientToServerEvents, ServerToClientEvents, TaskMutationSuccess } from '@syncboard/shared';
import { io, type Socket } from 'socket.io-client';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const baseUrl = args.get('url') ?? 'http://localhost:3001';
const clientCounts = (args.get('clients') ?? '1,10,50').split(',').map(Number);
const ops = Number(args.get('ops') ?? 100);
const intervalMs = Number(args.get('interval') ?? 120); // < 10 mutations/s per socket (server limit)

async function register(name: string): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `bench.${name}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: `Bench ${name}`, password: 'benchmark-password' }),
  });
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  const cookie = /sb_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')![0];
  const { user } = (await response.json()) as { user: { id: string } };
  return { cookie, userId: user.id, email };
}

async function api<T>(cookie: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function connect(cookie: string): Promise<ClientSocket> {
  const socket: ClientSocket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie } });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function join(socket: ClientSocket, boardId: string) {
  const ack = await socket.timeout(10_000).emitWithAck('board:join', { boardId });
  if (!ack.success) throw new Error(`join failed: ${ack.code}`);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
};
const fmt = (ms: number) => ms.toFixed(1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(readers: number) {
  const writer = await register('writer');
  const reader = await register('reader');
  const { board } = await api<{ board: BoardSummary }>(writer.cookie, 'POST', '/boards', { name: `Benchmark ${readers}` });
  await api(writer.cookie, 'POST', `/boards/${board.id}/members`, { email: reader.email });
  const snapshot = await api<BoardSnapshot>(writer.cookie, 'GET', `/boards/${board.id}/snapshot`);
  const created = await api<TaskMutationSuccess>(writer.cookie, 'POST', '/tasks', { boardId: board.id, columnId: snapshot.columns[0]!.id, title: 'Benchmark task' });
  const taskId = created.task!.id;

  const writerSocket = await connect(writer.cookie);
  await join(writerSocket, board.id);
  const readerSockets = await Promise.all(Array.from({ length: readers }, () => connect(reader.cookie)));
  await Promise.all(readerSockets.map((socket) => join(socket, board.id)));

  const sentAt = new Map<string, number>();
  const propagation: number[] = [];
  for (const socket of readerSockets) {
    socket.on('task:updated', (event) => {
      const start = sentAt.get(event.mutationId);
      if (start !== undefined) propagation.push(performance.now() - start);
    });
  }

  const acks: number[] = [];
  let version = created.task!.version;
  let failures = 0;
  for (let i = 0; i < ops; i++) {
    const mutationId = randomUUID();
    const start = performance.now();
    sentAt.set(mutationId, start);
    const ack = await writerSocket.timeout(10_000).emitWithAck('task:update', { mutationId, boardId: board.id, taskId, expectedVersion: version, changes: { description: `update ${i}` } });
    acks.push(performance.now() - start);
    if (ack.success) version = ack.task!.version;
    else failures++;
    await sleep(Math.max(0, intervalMs - (performance.now() - start)));
  }
  await sleep(500); // let the last broadcasts arrive

  for (const socket of [writerSocket, ...readerSockets]) socket.disconnect();
  await api(writer.cookie, 'DELETE', `/boards/${board.id}`).catch(() => undefined);

  const expected = ops * readers;
  return {
    readers,
    ops,
    failures,
    ack: { p50: percentile(acks, 50), p95: percentile(acks, 95), max: Math.max(...acks) },
    propagation: { p50: percentile(propagation, 50), p95: percentile(propagation, 95), max: Math.max(...propagation) },
    delivered: `${propagation.length}/${expected}`,
  };
}

console.log(`SyncBoard benchmark against ${baseUrl}`);
console.log(`Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.cpus().length} logical cores), ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()} ${os.release()}`);
console.log(`${ops} sequential task updates per run, one every ${intervalMs} ms\n`);
console.log('| reader sockets | ack p50 | ack p95 | ack max | propagation p50 | propagation p95 | propagation max | delivered | failed acks |');
console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const readers of clientCounts) {
  const r = await run(readers);
  console.log(
    `| ${r.readers} | ${fmt(r.ack.p50)} ms | ${fmt(r.ack.p95)} ms | ${fmt(r.ack.max)} ms | ${fmt(r.propagation.p50)} ms | ${fmt(r.propagation.p95)} ms | ${fmt(r.propagation.max)} ms | ${r.delivered} | ${r.failures} |`,
  );
}
