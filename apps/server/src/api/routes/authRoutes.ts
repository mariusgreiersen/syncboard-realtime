import { demoLoginSchema, loginSchema, registerSchema, updateProfileSchema } from '@syncboard/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SESSION_COOKIE } from '../../auth/sessions.js';
import type { UserRow } from '../../database/schema.js';
import { AppError, parseOrThrow } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import type { Services } from '../../services/container.js';
import { auth, requireAuth, sessionCookieOptions } from '../http.js';

const AUTH_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { config } = services;
  const authenticated = requireAuth(services.sessions, config);

  async function startSession(reply: FastifyReply, user: UserRow) {
    const session = await services.sessions.create(user.id);
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(config, session.expiresAt));
    reply.log.info({ event: 'auth.session_created', userId: user.id, demo: user.isDemo }, 'session created');
  }

  app.post('/auth/register', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const input = parseOrThrow(registerSchema, request.body);
    const user = await services.auth.register(input);
    await startSession(reply, user);
    return reply.status(201).send({ user: toUser(user) });
  });

  app.post('/auth/login', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const user = await services.auth.login(parseOrThrow(loginSchema, request.body));
    await startSession(reply, user);
    return { user: toUser(user) };
  });

  /** One-click demo sign-in as a seeded persona. Disabled unless DEMO_MODE=true. */
  app.post('/auth/demo', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    if (!config.DEMO_MODE) throw new AppError('NOT_FOUND', 'Demo mode is disabled on this server.');
    const { persona } = parseOrThrow(demoLoginSchema, request.body);
    const user = await services.demo.personaUser(persona);
    await startSession(reply, user);
    return { user: toUser(user) };
  });

  app.post('/auth/logout', async (request, reply) => {
    const resolved = await services.sessions.resolve(request.cookies[SESSION_COOKIE]);
    if (resolved) {
      await services.sessions.destroy(resolved.sessionId);
      // A logged-out session must not keep a live socket.
      services.realtime.disconnectSession(resolved.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: authenticated }, async (request) => ({ user: toUser(auth(request).user) }));

  app.patch('/users/me', { preHandler: authenticated }, async (request) => {
    const changes = parseOrThrow(updateProfileSchema, request.body);
    return { user: await services.auth.updateProfile(auth(request).user.id, changes) };
  });

  app.get('/config', async () => ({ demoMode: config.DEMO_MODE }));
}
