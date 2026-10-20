import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  DATABASE_URL: z.string().min(1).default('postgres://syncboard:syncboard@localhost:5434/syncboard'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Comma-separated list of browser origins allowed to call the API and open sockets. */
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8080'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  /** Trust X-Forwarded-* headers (enable behind a reverse proxy such as the bundled nginx). */
  TRUST_PROXY: booleanString.default(false),
  /** Set to true behind HTTPS so the session cookie gets the Secure attribute. */
  COOKIE_SECURE: booleanString.default(false),
  DEMO_MODE: booleanString.default(true),
  /** Periodically restore the seeded demo board (0 disables). */
  DEMO_RESET_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanString.default(false),
  /** Disable HTTP rate limits (used by load tests and benchmarks only). */
  RATE_LIMIT_DISABLED: booleanString.default(false),
});

export type AppConfig = Omit<z.output<typeof envSchema>, 'ALLOWED_ORIGINS'> & {
  ALLOWED_ORIGINS: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const config: AppConfig = {
    ...parsed.data,
    ALLOWED_ORIGINS: parsed.data.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
  return { ...config, ...overrides };
}
