import type { ApiErrorBody } from '@syncboard/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { SESSION_COOKIE, type AuthContext, type SessionStore } from '../auth/sessions.js';
import { AppError, errors } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function sessionCookieOptions(config: AppConfig, expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.COOKIE_SECURE,
    path: '/',
    expires,
  };
}

/** preHandler for protected routes: resolves the session cookie or rejects with 401. */
export function requireAuth(sessions: SessionStore, config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await sessions.resolve(request.cookies[SESSION_COOKIE]);
    if (!resolved) throw errors.unauthorized();
    if (resolved.renewed) {
      reply.setCookie(SESSION_COOKIE, request.cookies[SESSION_COOKIE]!, sessionCookieOptions(config, resolved.expiresAt));
    }
    request.auth = { user: resolved.user, sessionId: resolved.sessionId, expiresAt: resolved.expiresAt };
    request.log = request.log.child({ userId: resolved.user.id });
  };
}

export function auth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw errors.unauthorized();
  return request.auth;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth (on top of SameSite=Lax cookies and JSON-only bodies):
 * state-changing requests from a browser must come from an allowed origin.
 * Requests without an Origin header (curl, server-to-server tests) carry no ambient
 * browser credentials of a victim and are allowed.
 */
export function originGuard(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return async (request: FastifyRequest): Promise<void> => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' && (!origin || !allowed.has(origin))) {
      throw errors.forbidden('Cross-site request blocked.');
    }
    if (origin && !allowed.has(origin) && origin !== selfOrigin(request)) {
      throw errors.forbidden('Origin not allowed.');
    }
  };
}

function selfOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      const body: ApiErrorBody = { success: false, code: error.code, message: error.message };
      if (error.issues) body.issues = error.issues;
      if (error.currentTask !== undefined) body.currentTask = error.currentTask;
      if (error.currentVersion !== undefined) body.currentVersion = error.currentVersion;
      return reply.status(error.status).send(body);
    }
    // Fastify's own client errors: malformed JSON, unsupported media type, body too large, rate limits.
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } satisfies ApiErrorBody);
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ success: false, code: 'VALIDATION_ERROR', message: error.message } satisfies ApiErrorBody);
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ success: false, code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found.` } satisfies ApiErrorBody);
  });
}
