import pg from 'pg';
import { runMigrations } from '../../apps/server/src/database/migrate.js';
import { testDatabaseUrl } from './env.js';

/**
 * Creates a fresh, fully migrated test database once per test run.
 * Requires a reachable PostgreSQL (docker compose up -d postgres, or the CI service).
 */
export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const database = url.pathname.slice(1);
  if (!/^[\w-]+$/.test(database)) throw new Error(`Unsafe test database name: ${database}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL for integration tests at ${admin.host}. Start it with "docker compose up -d postgres" or set TEST_DATABASE_URL.`,
      { cause: error },
    );
  }
  try {
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
  await runMigrations(url.toString());
}
