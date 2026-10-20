import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

/**
 * Locates the migrations folder both from source (src/database) and from the
 * bundled output (dist/), and in the Docker image (/app/drizzle).
 */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/database/migrate.ts -> ../../drizzle ; dist/*.js -> ../drizzle
  const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, '../drizzle')];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, 'meta', '_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDatabase(connectionString, 1);
  try {
    await migrate(handle.db, { migrationsFolder: migrationsFolder() });
  } finally {
    await handle.close();
  }
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  const url = process.env.DATABASE_URL ?? 'postgres://syncboard:syncboard@localhost:5434/syncboard';
  runMigrations(url)
    .then(() => {
      console.log('Migrations applied.');
    })
    .catch((error: unknown) => {
      console.error('Migration failed:', error);
      process.exitCode = 1;
    });
}
