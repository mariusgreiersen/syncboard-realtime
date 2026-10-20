/**
 * Starts the API for Playwright: recreates an isolated database, migrates it, seeds the demo
 * data and serves on E2E_PORT. Used by playwright.config.ts (webServer).
 */
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.js';
import { loadConfig } from '../apps/server/src/config/env.js';
import { runMigrations } from '../apps/server/src/database/migrate.js';

const databaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://syncboard:syncboard@localhost:5434/syncboard_e2e';
const port = Number(process.env.E2E_PORT ?? 3101);

const url = new URL(databaseUrl);
const database = url.pathname.slice(1);
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
await client.query(`CREATE DATABASE "${database}"`);
await client.end();
await runMigrations(databaseUrl);

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  PORT: String(port),
  ALLOWED_ORIGINS: process.env.E2E_ORIGIN ?? 'http://localhost:5174',
  RATE_LIMIT_DISABLED: 'true',
  DEMO_MODE: 'true',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  LOG_PRETTY: 'false',
});
const syncboard = await buildApp(config);
await syncboard.services.demo.ensureDemoData();
await syncboard.app.listen({ host: '127.0.0.1', port });
console.log(`e2e server listening on ${port}`);

const stop = async () => {
  await syncboard.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
