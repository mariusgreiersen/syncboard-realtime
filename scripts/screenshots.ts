/**
 * Captures the README screenshots from a running stack (default: Docker Compose on :8080).
 * Every state shown is produced by the real app: real sockets, real server, real database.
 * The "Reconnecting" shot stops and restarts the server container (requires Docker Compose).
 *
 *   docker compose up -d && npm run screenshots
 *   PW_CHANNEL=msedge npm run screenshots   # use an installed browser
 */
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

const base = process.env.SCREENSHOT_URL ?? 'http://localhost:8080';
const out = path.resolve('docs/screenshots');
mkdirSync(out, { recursive: true });
const viewport = { width: 1440, height: 900 };

async function persona(browser: Browser, name: 'alice' | 'bob' | 'charlie', options: { theme?: 'light' | 'dark'; diagnostics?: boolean; size?: { width: number; height: number } } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: options.size ?? viewport, deviceScaleFactor: 2, colorScheme: options.theme ?? 'light' });
  await context.addInitScript(
    ([theme, diagnostics]) => {
      window.localStorage.setItem('syncboard-ui', JSON.stringify({ state: { theme, diagnostics, activityOpen: false, recentBoardIds: [] }, version: 0 }));
    },
    [options.theme ?? 'light', options.diagnostics ?? false] as const,
  );
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByTestId(`demo-${name}`).click();
  await page.waitForURL(`${base}/`);
  return page;
}

async function openDemoBoard(page: Page) {
  await page.getByRole('link', { name: /Product Launch Workspace/ }).first().click();
  await page.locator('[data-testid="connection-status"][data-state="connected"]').waitFor();
  await page.waitForTimeout(400);
}

const column = (page: Page, name: string) => page.locator(`[data-testid="kanban-column"][data-column-name="${name}"]`);

async function addTask(page: Page, columnName: string, title: string) {
  const col = column(page, columnName);
  await col.getByRole('button', { name: `Add task to ${columnName}` }).click();
  await col.getByLabel('New task title').fill(title);
  await col.getByLabel('New task title').press('Enter');
  await col.getByRole('button', { name: 'Cancel' }).click();
}

async function sideBySide(browser: Browser, left: Buffer, right: Buffer, file: string, labels: [string, string]) {
  const page = await browser.newPage({ viewport: { width: 1880, height: 720 }, deviceScaleFactor: 1 });
  const img = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
  await page.setContent(`
    <body style="margin:0;background:#0f172a;font-family:Inter,Segoe UI,sans-serif">
      <div style="display:flex;gap:20px;padding:20px">
        ${[left, right]
          .map(
            (shot, i) => `<figure style="margin:0;flex:1">
              <figcaption style="color:#cbd5e1;font-size:15px;margin:0 0 10px 4px;font-weight:600">${labels[i]}</figcaption>
              <img src="${img(shot)}" style="width:100%;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35)"/>
            </figure>`,
          )
          .join('')}
      </div>
    </body>`);
  await page.screenshot({ path: path.join(out, file), fullPage: true });
  await page.close();
}

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
try {
  // Login
  {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    await page.screenshot({ path: path.join(out, 'login.png') });
    await context.close();
  }

  // Board (light + dark) with three collaborators online
  const alice = await persona(browser, 'alice');
  await openDemoBoard(alice);
  const bob = await persona(browser, 'bob');
  await openDemoBoard(bob);
  const charlie = await persona(browser, 'charlie', { theme: 'dark' });
  await openDemoBoard(charlie);
  await alice.getByTestId('presence-count').filter({ hasText: '3 people viewing' }).waitFor();
  await alice.screenshot({ path: path.join(out, 'board.png') });
  await charlie.screenshot({ path: path.join(out, 'board-dark.png') });
  await alice.locator('main header').first().screenshot({ path: path.join(out, 'presence.png') });

  // Task details drawer
  await alice.locator('[data-task-title="Implement authentication"]').click();
  await alice.getByTestId('task-dialog').waitFor();
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: path.join(out, 'task-details.png') });
  await alice.keyboard.press('Escape');

  // Two browsers side by side: Alice creates a task, Bob sees it live
  const small = { width: 1200, height: 760 };
  const a = await persona(browser, 'alice', { size: small });
  await openDemoBoard(a);
  const b = await persona(browser, 'bob', { size: small });
  await openDemoBoard(b);
  await addTask(a, 'To Do', 'Record the real-time demo video');
  await b.locator('[data-task-title="Record the real-time demo video"]').waitFor();
  await b.locator('[data-task-title="Record the real-time demo video"]').scrollIntoViewIfNeeded();
  await a.waitForTimeout(300);
  await sideBySide(browser, await a.screenshot(), await b.screenshot(), 'two-browsers.png', ['Browser A — Alice creates a task', 'Browser B — Bob sees it instantly']);

  // Conflict: both edit the same task; Alice saves first, Bob's stale save is rejected
  await a.locator('[data-task-title="Write API documentation"]').click();
  await b.locator('[data-task-title="Write API documentation"]').click();
  await b.getByTestId('task-title-input').fill('Write REST API reference');
  await a.getByTestId('task-title-input').fill('Write OpenAPI documentation');
  await a.getByTestId('task-save').click();
  await b.getByTestId('remote-change-banner').waitFor();
  await b.getByTestId('task-save').click();
  await b.getByTestId('conflict-panel').waitFor();
  await b.waitForTimeout(400);
  await b.screenshot({ path: path.join(out, 'conflict.png') });

  // Connection recovery: stop the server container → clients show "Reconnecting…"
  const watcher = await persona(browser, 'bob', { diagnostics: true });
  await openDemoBoard(watcher);
  execSync('docker compose stop server', { stdio: 'ignore' });
  await watcher.locator('[data-testid="connection-status"][data-state="reconnecting"]').waitFor({ timeout: 30_000 });
  await watcher.waitForTimeout(1_500);
  await watcher.screenshot({ path: path.join(out, 'reconnecting.png') });
  execSync('docker compose start server', { stdio: 'ignore' });
  await watcher.locator('[data-testid="connection-status"][data-state="connected"]').waitFor({ timeout: 60_000 });
  await watcher.waitForTimeout(800);
  await watcher.screenshot({ path: path.join(out, 'recovered.png') });
} finally {
  await browser.close();
}

// Leave the demo board as seeded.
execSync('docker compose exec -T server node dist/seed.js --reset', { stdio: 'ignore' });
console.log(`Screenshots written to ${out}`);

