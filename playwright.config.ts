import { defineConfig, devices } from '@playwright/test';

/*
 * Multi-browser end-to-end tests: each test opens independent browser contexts (separate
 * cookie jars = separate users) against the real API, Socket.IO server and PostgreSQL.
 *
 *   npm run test:e2e                       # bundled Chromium (CI: npx playwright install chromium)
 *   PW_CHANNEL=msedge npm run test:e2e     # use an installed Edge/Chrome instead
 */

const API_PORT = 3101;
const CLIENT_PORT = 5174;
const channel = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(channel ? { channel } : {}) } }],
  webServer: [
    {
      command: 'npx tsx scripts/e2e-server.ts',
      url: `http://127.0.0.1:${API_PORT}/health/ready`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: { E2E_PORT: String(API_PORT), E2E_ORIGIN: `http://localhost:${CLIENT_PORT}` },
      stdout: 'pipe',
    },
    {
      command: 'npm run dev -w @syncboard/client',
      url: `http://localhost:${CLIENT_PORT}`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: { CLIENT_PORT: String(CLIENT_PORT), VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
