import type { User } from '@syncboard/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, registerUser, sqlQuery, startServer, truncateAll, type TestServer } from '../helpers/harness.js';

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

describe('authentication', () => {
  it('registers, sets an HTTP-only session cookie and returns the profile', async () => {
    const client = new ApiClient(server.url);
    const response = await client.post<{ user: User }>('/api/v1/auth/register', {
      email: '  Ada@Example.com ',
      password: 'correct horse battery',
      name: 'Ada Lovelace',
    });
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada Lovelace', isDemo: false });
    expect(response.body.user).not.toHaveProperty('passwordHash');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/sb_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await client.get<{ user: User }>('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ada@example.com');
  });

  it('stores only a scrypt hash of the password and a SHA-256 hash of the session token', async () => {
    const client = await registerUser(server.url, 'Grace');
    const [row] = await sqlQuery<{ password_hash: string }>('select password_hash from users where id = $1', [client.user.id]);
    expect(row!.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    const token = client.cookie!.split('=')[1]!;
    const sessions = await sqlQuery<{ token_hash: string }>('select token_hash from sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.token_hash).not.toContain(token);
    expect(sessions[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs in with the right password and rejects the wrong one with the same message as an unknown email', async () => {
    const registered = await registerUser(server.url, 'Linus');
    const client = new ApiClient(server.url);

    const wrong = await client.post('/api/v1/auth/login', { email: registered.user.email, password: 'wrong password!' });
    const unknown = await client.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'whatever123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toMatchObject({ success: false, code: 'UNAUTHORIZED' });

    const ok = await client.post<{ user: User }>('/api/v1/auth/login', { email: registered.user.email, password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(registered.user.id);
  });

  it('rejects duplicate emails, short passwords and reserved demo addresses', async () => {
    const first = await registerUser(server.url, 'Margaret');
    const client = new ApiClient(server.url);
    const duplicate = await client.post('/api/v1/auth/register', { email: first.user.email, password: 'another password', name: 'M' });
    expect(duplicate.status).toBe(409);

    const short = await client.post<{ code: string; issues: unknown[] }>('/api/v1/auth/register', { email: 'x@example.com', password: 'short', name: 'X' });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('VALIDATION_ERROR');
    expect(short.body.issues.length).toBeGreaterThan(0);

    const reserved = await client.post('/api/v1/auth/register', { email: 'mallory@syncboard.test', password: 'long enough pw', name: 'Mallory' });
    expect(reserved.status).toBe(400);
  });

  it('protects routes and invalidates the session on logout', async () => {
    const anonymous = new ApiClient(server.url);
    expect((await anonymous.get('/api/v1/auth/me')).status).toBe(401);
    expect((await anonymous.get('/api/v1/boards')).status).toBe(401);

    const client = await registerUser(server.url, 'Barbara');
    const stolenCookie = client.cookie!;
    expect((await client.post('/api/v1/auth/logout')).status).toBe(204);
    expect(client.cookie).toBeNull();

    const replay = new ApiClient(server.url);
    replay.cookie = stolenCookie;
    expect((await replay.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('blocks state-changing requests from foreign origins and non-JSON bodies', async () => {
    const client = await registerUser(server.url, 'Eve');
    const foreign = await client.request('POST', '/api/v1/boards', { name: 'Evil' }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);

    const form = await fetch(`${server.url}/api/v1/boards`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie: client.cookie! },
      body: '{"name":"Sneaky"}',
    });
    expect(form.status).toBe(415);
    const boards = await sqlQuery('select id from boards');
    expect(boards).toHaveLength(0);
  });

  it('updates the profile', async () => {
    const client = await registerUser(server.url, 'Katherine');
    const response = await client.patch<{ user: User }>('/api/v1/users/me', { name: 'Katherine J.', avatarColor: '#10b981' });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ name: 'Katherine J.', avatarColor: '#10b981' });
    expect((await client.patch('/api/v1/users/me', { avatarColor: 'red' })).status).toBe(400);
  });
});

describe('health', () => {
  it('reports liveness and database readiness', async () => {
    expect((await fetch(`${server.url}/health/live`)).status).toBe(200);
    const ready = await fetch(`${server.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', database: 'up' });
  });
});
