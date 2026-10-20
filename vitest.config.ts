import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/shared/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '@': path.resolve(import.meta.dirname, 'apps/client/src') } },
        test: {
          name: 'client',
          root: './apps/client',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts', 'tests/realtime/**/*.test.ts'],
          globalSetup: ['./tests/helpers/globalSetup.ts'],
          // Test files share one database and truncate it between tests.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
