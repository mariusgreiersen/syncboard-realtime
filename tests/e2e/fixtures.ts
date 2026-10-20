import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { BoardSnapshot, BoardSummary, User } from '@syncboard/shared';

export interface Collaborator {
  context: BrowserContext;
  page: Page;
  user: User;
}

let counter = 0;
const openContexts = new Set<BrowserContext>();

/** Close every context a test opened, so sockets from earlier tests never linger. */
export async function closeAll(): Promise<void> {
  for (const context of openContexts) await context.close().catch(() => undefined);
  openContexts.clear();
}

export async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  openContexts.add(context);
  return context;
}

/** A separate browser context (own cookies, own socket) signed in as a freshly registered user. */
export async function openAs(browser: Browser, name: string, options: { diagnostics?: boolean } = {}): Promise<Collaborator> {
  const context = await newContext(browser);
  if (options.diagnostics) {
    await context.addInitScript(() => {
      window.localStorage.setItem('syncboard-ui', JSON.stringify({ state: { theme: 'light', diagnostics: true, activityOpen: false, recentBoardIds: [] }, version: 0 }));
    });
  }
  const page = await context.newPage();
  counter += 1;
  const email = `${name.toLowerCase()}.${Date.now()}.${counter}@example.com`;
  const response = await context.request.post('/api/v1/auth/register', { data: { email, name, password: 'correct horse battery' } });
  expect(response.status()).toBe(201);
  const { user } = (await response.json()) as { user: User };
  return { context, page, user };
}

/** Alice creates a board through the API and adds the others as members. */
export async function sharedBoard(owner: Collaborator, members: Collaborator[], name = 'E2E Launch'): Promise<BoardSnapshot> {
  const created = await owner.context.request.post('/api/v1/boards', { data: { name, description: 'Created by the Playwright suite' } });
  expect(created.status()).toBe(201);
  const { board } = (await created.json()) as { board: BoardSummary };
  for (const member of members) {
    const added = await owner.context.request.post(`/api/v1/boards/${board.id}/members`, { data: { email: member.user.email } });
    expect(added.status()).toBe(201);
  }
  return snapshot(owner, board.id);
}

export async function snapshot(who: Collaborator, boardId: string): Promise<BoardSnapshot> {
  const response = await who.context.request.get(`/api/v1/boards/${boardId}/snapshot`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as BoardSnapshot;
}

export async function openBoard(who: Collaborator, boardId: string): Promise<void> {
  await who.page.goto(`/boards/${boardId}`);
  await expect(who.page.getByTestId('kanban-board')).toBeVisible();
  await expect(who.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
}

export const column = (page: Page, name: string): Locator => page.locator(`[data-testid="kanban-column"][data-column-name="${name}"]`);
export const card = (scope: Page | Locator, title: string): Locator => scope.locator(`[data-testid="task-card"][data-task-title="${title}"]`);

/** Task titles of a column, in rendered order. */
export async function columnTitles(page: Page, name: string): Promise<string[]> {
  return column(page, name).locator('[data-testid="task-card"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-task-title') ?? ''));
}

/** The whole board as rendered: column name -> ordered titles. */
export async function renderedBoard(page: Page): Promise<Record<string, string[]>> {
  return page.locator('[data-testid="kanban-column"]').evaluateAll((columns) =>
    Object.fromEntries(
      columns.map((col) => [
        col.getAttribute('data-column-name') ?? '',
        [...col.querySelectorAll('[data-testid="task-card"]')].map((node) => node.getAttribute('data-task-title') ?? ''),
      ]),
    ),
  );
}

/** The authoritative board from PostgreSQL (via the snapshot endpoint) in the same shape. */
export async function authoritativeBoard(who: Collaborator, boardId: string): Promise<Record<string, string[]>> {
  const snap = await snapshot(who, boardId);
  return Object.fromEntries(snap.columns.map((c) => [c.name, snap.tasks.filter((t) => t.columnId === c.id).map((t) => t.title)]));
}

export async function addTask(page: Page, columnName: string, title: string): Promise<void> {
  const col = column(page, columnName);
  await col.getByRole('button', { name: 'Add task', exact: true }).click();
  await col.getByLabel('New task title').fill(title);
  await col.getByLabel('New task title').press('Enter');
  await col.getByRole('button', { name: 'Cancel' }).click();
}

/** Real pointer drag-and-drop (dnd-kit needs intermediate pointer moves to activate). */
export async function dragCard(page: Page, title: string, toColumn: string): Promise<void> {
  const source = await card(page, title).boundingBox();
  const target = await column(page, toColumn).getByTestId('column-tasks').boundingBox();
  if (!source || !target) throw new Error('drag targets not visible');
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 4, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + 24, { steps: 25 });
  await page.mouse.move(target.x + target.width / 2, target.y + 20, { steps: 5 });
  await page.mouse.up();
}
