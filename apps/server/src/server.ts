import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const syncboard = await buildApp(config);
const { app } = syncboard;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ event: 'server.shutdown', signal }, 'shutting down');
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  try {
    await syncboard.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  syncboard.startBackgroundJobs();
  app.log.info({ event: 'server.started', port: config.PORT, demoMode: config.DEMO_MODE }, 'SyncBoard server ready');
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await syncboard.close().catch(() => undefined);
  process.exit(1);
}
