import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/env.js';
import { createLogger, type Log } from '../lib/logger.js';
import { DemoService } from '../modules/demo/demoService.js';
import { noopPublisher } from '../modules/mutations/publisher.js';
import { createDatabase } from './client.js';

/**
 * Seeds the demo users (Alice, Bob, Charlie) and the "Product Launch Workspace" board.
 *   npm run db:seed            # create if missing (idempotent)
 *   npm run db:seed -- --reset # restore the demo board to its seeded content
 */
export async function seed(databaseUrl: string, options: { reset?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config) as unknown as Log;
  const handle = createDatabase(databaseUrl, 2);
  try {
    const demo = new DemoService(handle.db, noopPublisher, log);
    if (options.reset) await demo.resetDemo();
    else await demo.ensureDemoData();
  } finally {
    await handle.close();
  }
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  const reset = process.argv.includes('--reset');
  seed(loadConfig().DATABASE_URL, { reset })
    .then(() => console.log(reset ? 'Demo data reset.' : 'Demo data ready.'))
    .catch((error: unknown) => {
      console.error('Seeding failed:', error);
      process.exitCode = 1;
    });
}
