export const testDatabaseUrl = (): string =>
  process.env.TEST_DATABASE_URL ?? 'postgres://syncboard:syncboard@localhost:5434/syncboard_test';

export const TEST_ORIGIN = 'http://localhost:5173';
