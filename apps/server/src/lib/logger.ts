import pino from 'pino';
import type { AppConfig } from '../config/env.js';

/** The subset of the Pino API used by services (satisfied by Pino and Fastify loggers). */
export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Log;
}

/** Never log credentials or session tokens. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
];

export function loggerOptions(config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY'>): pino.LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(config.LOG_PRETTY ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } } : {}),
  };
}

export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY'>): pino.Logger {
  return pino(loggerOptions(config));
}
