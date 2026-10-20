import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pool-backed database or an open transaction. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDatabase(connectionString: string, max = 10): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'syncboard-server',
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** PostgreSQL error codes we handle explicitly. */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  // Drizzle wraps driver errors; walk the cause chain.
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && current !== null && 'constraint' in current) {
      const constraint = (current as { constraint?: unknown }).constraint;
      if (typeof constraint === 'string') return constraint;
    }
    current = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}
