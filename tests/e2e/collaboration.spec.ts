import { expect, test } from '@playwright/test';
import { addTask, authoritativeBoard, card, closeAll, column, columnTitles, dragCard, newContext, openAs, openBoard, renderedBoard, sharedBoard, snapshot } from './fixtures';

test.afterEach(async () => {
  await closeAll();
});

/*
 * Two (or more) independent browser contexts = two users with their own session cookie and
 * their own Socket.IO connection. No page is reloaded during these scenarios; every update
 * arrives through the real server and PostgreSQL.
 */

test('Scenario A — live collaboration: create, move and edit propagate between browsers', async ({ browser }) => {
  const alice = await openAs(browser, 'Alice');
  const bob = await openAs(browser, 'Bob');
  const board = await sharedBoard(alice, [bob]);
  await openBoard(alice, board.board.id);
  await openBoard(bob, board.board.id);

  // Both appear in each other's presence indicator.
  await expect(alice.page.getByTestId('presence-user')).toHaveCount(2);
  await expect(bob.page.getByTestId('presence-count')).toHaveText('2 people viewing');

  // 1. Alice creates a task; it appears in Bob's browser without a refresh.
  await addTask(alice.page, 'To Do', 'Implement authentication');
  await expect(card(column(bob.page, 'To Do'), 'Implement authentication')).toBeVisible();

  // 2. Bob drags it to In Progress; Alice's board updates.
  await dragCard(bob.page, 'Implement authentication', 'In Progress');
  await expect(card(column(bob.page, 'In Progress'), 'Implement authentication')).toBeVisible();
  await expect(card(column(alice.page, 'In Progress'), 'Implement authentication')).toBeVisible();
  await expect(card(column(alice.page, 'To Do'), 'Implement authentication')).toHaveCount(0);

  // 3. Alice opens the task; Bob changes its priority; Alice sees the committed change in the open drawer.
  await card(alice.page, 'Implement authentication').click();
  await expect(alice.page.getByTestId('task-dialog')).toBeVisible();
  await expect(alice.page.getByTestId('task-priority')).toHaveText(/Medium/);

  await card(bob.page, 'Implement authentication').click();
  await bob.page.getByTestId('task-priority').click();
  await bob.page.getByRole('option', { name: 'Urgent' }).click();
  await bob.page.getByTestId('task-save').click();
  await expect(bob.page.getByText('Task saved')).toBeVisible();

  await expect(alice.page.getByTestId('task-priority')).toHaveText(/Urgent/);

  // 4. Alice edits the description; Bob sees it.
  await alice.page.getByTestId('task-description-input').fill('Sessions in HTTP-only cookies.');
  await alice.page.getByTestId('task-save').click();
  await expect(bob.page.getByTestId('task-description-input')).toHaveValue('Sessions in HTTP-only cookies.');

  // The database agrees with what both browsers show.
  const snap = await snapshot(alice, board.board.id);
  const task = snap.tasks.find((t) => t.title === 'Implement authentication')!;
  expect(task).toMatchObject({ priority: 'urgent', description: 'Sessions in HTTP-only cookies.', version: 4 });
  expect(snap.columns.find((c) => c.id === task.columnId)!.name).toBe('In Progress');
});

test('Scenario B — reconnection: an offline browser catches up with changes made while it was away', async ({ browser }) => {
  const alice = await openAs(browser, 'Alice', { diagnostics: true });
  const bob = await openAs(browser, 'Bob');
  const board = await sharedBoard(alice, [bob]);
  await openBoard(alice, board.board.id);
  await openBoard(bob, board.board.id);
  await addTask(bob.page, 'Backlog', 'Write API documentation');
  await expect(card(alice.page, 'Write API documentation')).toBeVisible();

  // Alice's socket disconnects. The board stays visible and mutations are disabled.
  await alice.page.getByTestId('diag-disconnect').click();
  await expect(alice.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'offline');
  await expect(alice.page.getByTestId('offline-banner')).toBeVisible();
  await expect(column(alice.page, 'To Do').getByRole('button', { name: 'Add task', exact: true })).toBeDisabled();
  await expect(bob.page.getByTestId('presence-user')).toHaveCount(1);

  // Bob keeps working: creates two tasks and moves one.
  await addTask(bob.page, 'To Do', 'Configure CI/CD');
  await addTask(bob.page, 'To Do', 'Design dashboard');
  await dragCard(bob.page, 'Write API documentation', 'Done');
  await expect(card(column(bob.page, 'Done'), 'Write API documentation')).toBeVisible();
  // Alice has not seen any of it.
  await expect(card(alice.page, 'Configure CI/CD')).toHaveCount(0);
  await expect(card(column(alice.page, 'Backlog'), 'Write API documentation')).toBeVisible();

  // Alice reconnects without reloading: rejoin → snapshot → reconcile.
  await alice.page.getByTestId('diag-reconnect').click();
  await expect(alice.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
  await expect(card(column(alice.page, 'To Do'), 'Design dashboard')).toBeVisible();
  await expect(card(column(alice.page, 'Done'), 'Write API documentation')).toBeVisible();

  // Both browsers match the authoritative PostgreSQL state, including order.
  const expected = await authoritativeBoard(bob, board.board.id);
  await expect.poll(() => renderedBoard(alice.page)).toEqual(expected);
  await expect.poll(() => renderedBoard(bob.page)).toEqual(expected);
  expect(await columnTitles(alice.page, 'To Do')).toEqual(['Configure CI/CD', 'Design dashboard']);
  await expect(bob.page.getByTestId('presence-user')).toHaveCount(2);
});

test('Scenario C — conflict: a stale edit is rejected with a clear message and nothing is lost', async ({ browser }) => {
  const alice = await openAs(browser, 'Alice');
  const bob = await openAs(browser, 'Bob', { diagnostics: true });
  const board = await sharedBoard(alice, [bob]);
  await openBoard(alice, board.board.id);
  await openBoard(bob, board.board.id);
  await addTask(alice.page, 'To Do', 'Implement login');
  await expect(card(bob.page, 'Implement login')).toBeVisible();

  // Both open the same task at version 1.
  await card(alice.page, 'Implement login').click();
  await card(bob.page, 'Implement login').click();

  // Bob starts typing (unsaved), then Alice saves first.
  await bob.page.getByTestId('task-title-input').fill('Implement email login');
  await alice.page.getByTestId('task-title-input').fill('Implement OAuth login');
  await alice.page.getByTestId('task-save').click();
  await expect(alice.page.getByText('Task saved')).toBeVisible();

  // Bob is warned live, before he even saves.
  await expect(bob.page.getByTestId('remote-change-banner')).toBeVisible();
  // Bob submits his stale edit: the server rejects it with VERSION_CONFLICT.
  await bob.page.getByTestId('task-save').click();
  const panel = bob.page.getByTestId('conflict-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('This task was modified by another collaborator.');
  await expect(panel).toContainText('Implement OAuth login');
  await expect(panel).toContainText('Implement email login');
  await expect(bob.page.getByText('This task was changed by another collaborator. The board has been refreshed.')).toBeVisible();
  await expect(bob.page.getByTestId('diag-conflicts')).toHaveText('1');

  // No silent data loss: Alice's committed title is what PostgreSQL holds; Bob's draft is still in his form.
  let snap = await snapshot(alice, board.board.id);
  expect(snap.tasks[0]).toMatchObject({ title: 'Implement OAuth login', version: 2 });
  await expect(bob.page.getByTestId('task-title-input')).toHaveValue('Implement email login');
  await expect(card(bob.page, 'Implement OAuth login')).toBeVisible();

  // Bob decides deliberately: re-apply his change on top of Alice's version.
  await bob.page.getByTestId('conflict-keep-mine').click();
  await expect(bob.page.getByText('Task saved')).toBeVisible();
  await expect(card(alice.page, 'Implement email login')).toBeVisible();
  snap = await snapshot(alice, board.board.id);
  expect(snap.tasks[0]).toMatchObject({ title: 'Implement email login', version: 3 });
});

test('presence counts a user with two tabs once', async ({ browser }) => {
  const alice = await openAs(browser, 'Alice');
  const bob = await openAs(browser, 'Bob');
  const board = await sharedBoard(alice, [bob]);
  await openBoard(alice, board.board.id);
  await openBoard(bob, board.board.id);
  const bobSecondTab = await bob.context.newPage();
  await bobSecondTab.goto(`/boards/${board.board.id}`);
  await expect(bobSecondTab.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');

  await expect(alice.page.getByTestId('presence-user')).toHaveCount(2);
  await bobSecondTab.close();
  await expect(alice.page.getByTestId('presence-user')).toHaveCount(2);
  await bob.page.close();
  await expect(alice.page.getByTestId('presence-user')).toHaveCount(1);
});

test('order persists across a reload and filters never reorder hidden cards', async ({ browser }) => {
  const alice = await openAs(browser, 'Alice');
  const board = await sharedBoard(alice, []);
  await openBoard(alice, board.board.id);
  for (const title of ['Alpha task', 'Beta task', 'Gamma task']) await addTask(alice.page, 'To Do', title);
  await expect.poll(() => columnTitles(alice.page, 'To Do')).toEqual(['Alpha task', 'Beta task', 'Gamma task']);

  // Filter to "Gamma", drag it to Done, clear the filter: hidden cards keep their order.
  await alice.page.getByTestId('search-input').fill('Gamma');
  await expect(column(alice.page, 'To Do').getByTestId('task-card')).toHaveCount(1);
  await dragCard(alice.page, 'Gamma task', 'Done');
  await expect(card(column(alice.page, 'Done'), 'Gamma task')).toBeVisible();
  await alice.page.getByTestId('clear-filters').click();
  await expect.poll(() => columnTitles(alice.page, 'To Do')).toEqual(['Alpha task', 'Beta task']);

  await alice.page.reload();
  await expect(alice.page.getByTestId('kanban-board')).toBeVisible();
  await expect.poll(() => renderedBoard(alice.page)).toEqual(await authoritativeBoard(alice, board.board.id));
  expect(await columnTitles(alice.page, 'Done')).toEqual(['Gamma task']);
});

test('the seeded demo board works with one-click persona sign-in', async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('demo-charlie').click();
  await page.getByRole('link', { name: /Product Launch Workspace/ }).first().click();
  await expect(page.getByTestId('board-title')).toHaveText('Product Launch Workspace');
  await expect(page.getByTestId('task-card')).toHaveCount(18);
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
});
