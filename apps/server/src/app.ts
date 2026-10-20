import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, lt } from 'drizzle-orm';
import { originGuard, registerErrorHandler } from './api/http.js';
import { authRoutes } from './api/routes/authRoutes.js';
import { boardRoutes } from './api/routes/boardRoutes.js';
import { taskRoutes } from './api/routes/taskRoutes.js';
import type { AppConfig } from './config/env.js';
import { createDatabase, type DatabaseHandle } from './database/client.js';
import { processedMutations } from './database/schema.js';
import { loggerOptions, type Log } from './lib/logger.js';
import { createRealtimeServer, type RealtimeServer } from './realtime/socketServer.js';
import { createServices, type Services } from './services/container.js';

export interface SyncBoardApp {
  app: FastifyInstance;
  services: Services;
  realtime: RealtimeServer;
  database: DatabaseHandle;
  /** Starts periodic maintenance (session/ledger pruning, optional demo reset). */
  startBackgroundJobs: () => void;
  close: () => Promise<void>;
}

export async function buildApp(config: AppConfig): Promise<SyncBoardApp> {
  const database = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const app = Fastify({
    logger: loggerOptions(config),
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    },
    bodyLimit: 64 * 1024,
    trustProxy: config.TRUST_PROXY,
  });
  const log = app.log as unknown as Log;
  const services = createServices(database.db, config, log);

  app.decorateRequest('auth', null);
  // Accept JSON bodies only: HTML forms cannot send application/json cross-site without a CORS preflight.
  app.removeContentTypeParser(['text/plain']);

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: config.ALLOWED_ORIGINS, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'] });
  if (!config.RATE_LIMIT_DISABLED) {
    await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  }
  app.addHook('onRequest', originGuard(config.ALLOWED_ORIGINS));
  registerErrorHandler(app);

  // Probed every few seconds by Docker/orchestrators: keep them out of the request log.
  app.get('/health/live', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { logLevel: 'warn' }, async (_request, reply) => {
    try {
      await database.db.execute(sql`select 1`);
      return { status: 'ok', database: 'up' };
    } catch {
      return reply.status(503).send({ status: 'unavailable', database: 'down' });
    }
  });

  await app.register(
    async (api) => {
      await api.register(async (scope) => authRoutes(scope, services));
      await api.register(async (scope) => boardRoutes(scope, services));
      await api.register(async (scope) => taskRoutes(scope, services));
    },
    { prefix: '/api/v1' },
  );

  const realtime = createRealtimeServer(app.server, services, log);
  const timers: NodeJS.Timeout[] = [];

  return {
    app,
    services,
    realtime,
    database,
    startBackgroundJobs() {
      const prune = async () => {
        try {
          const sessionsPruned = await services.sessions.pruneExpired();
          const ledger = await database.db
            .delete(processedMutations)
            .where(lt(processedMutations.createdAt, new Date(Date.now() - 24 * 3_600_000)))
            .returning({ id: processedMutations.id });
          log.info({ event: 'maintenance.pruned', sessions: sessionsPruned, mutations: ledger.length }, 'maintenance completed');
        } catch (error) {
          log.error({ err: error }, 'maintenance failed');
        }
      };
      timers.push(setInterval(prune, 3_600_000));
      void prune();
      if (config.DEMO_MODE && config.DEMO_RESET_INTERVAL_MINUTES > 0) {
        timers.push(
          setInterval(() => {
            services.demo.resetDemo().catch((error: unknown) => log.error({ err: error }, 'demo reset failed'));
          }, config.DEMO_RESET_INTERVAL_MINUTES * 60_000),
        );
      }
      for (const timer of timers) timer.unref();
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      await realtime.close();
      await app.close();
      await database.close();
    },
  };
}
