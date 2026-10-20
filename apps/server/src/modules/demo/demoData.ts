import type { DemoPersona, Priority } from '@syncboard/shared';

/** Fixed id so the demo board keeps its URL across resets. */
export const DEMO_BOARD_ID = '5b0a2d5e-3c1f-4d2a-9a47-7f1c0d9e5a11';
export const DEMO_PASSWORD = 'syncboard-demo';

export const DEMO_USERS: Record<DemoPersona, { email: string; name: string; avatarColor: string }> = {
  alice: { email: 'alice@syncboard.test', name: 'Alice Andersen', avatarColor: '#6366f1' },
  bob: { email: 'bob@syncboard.test', name: 'Bob Nielsen', avatarColor: '#0ea5e9' },
  charlie: { email: 'charlie@syncboard.test', name: 'Charlie Holm', avatarColor: '#f59e0b' },
};

export const DEMO_BOARD = {
  name: 'Product Launch Workspace',
  description: 'Everything the team needs to ship SyncBoard 1.0: engineering, design and launch tasks.',
  accent: 'indigo' as const,
};

export const DEMO_COLUMNS = ['Backlog', 'To Do', 'In Progress', 'Done'] as const;

interface DemoTask {
  column: (typeof DEMO_COLUMNS)[number];
  title: string;
  description: string;
  priority: Priority;
  assignee: DemoPersona | null;
  /** Days from the seed date; null for no due date. */
  dueInDays: number | null;
  labels: string[];
}

export const DEMO_TASKS: DemoTask[] = [
  { column: 'Backlog', title: 'Build analytics page', description: 'Weekly active boards, tasks completed per week and median cycle time. Read-only for members.', priority: 'medium', assignee: null, dueInDays: 30, labels: ['frontend', 'analytics'] },
  { column: 'Backlog', title: 'Evaluate Redis adapter for Socket.IO', description: 'Spike: what changes when we run more than one server instance? Presence, rooms and reconnection all need a shared backplane.', priority: 'low', assignee: 'bob', dueInDays: null, labels: ['backend', 'research'] },
  { column: 'Backlog', title: 'Board templates', description: 'Let owners start a board from "Sprint", "Content calendar" or "Bug triage" templates.', priority: 'low', assignee: null, dueInDays: null, labels: ['product'] },
  { column: 'Backlog', title: 'Email notifications for assignments', description: 'Send a digest when you are assigned a task. Needs an outbound email provider first.', priority: 'medium', assignee: null, dueInDays: null, labels: ['backend'] },
  { column: 'Backlog', title: 'Keyboard shortcuts cheat sheet', description: 'Press ? to show available shortcuts (new task, search, move card).', priority: 'low', assignee: 'charlie', dueInDays: null, labels: ['frontend', 'a11y'] },
  { column: 'To Do', title: 'Create onboarding flow', description: 'Three-step welcome for new workspaces: name the board, invite teammates, create the first task.', priority: 'high', assignee: 'charlie', dueInDays: 9, labels: ['design', 'frontend'] },
  { column: 'To Do', title: 'Write API documentation', description: 'Document every /api/v1 endpoint with request and response examples, status codes and conflict behaviour.', priority: 'medium', assignee: 'bob', dueInDays: 6, labels: ['docs'] },
  { column: 'To Do', title: 'Test payment integration', description: 'Run the sandbox test cards (success, declined, 3-D Secure) and verify webhook retries.', priority: 'urgent', assignee: 'alice', dueInDays: 3, labels: ['backend', 'billing'] },
  { column: 'To Do', title: 'Improve responsive layout', description: 'Columns should scroll horizontally on phones; the task drawer becomes full-screen below 640px.', priority: 'medium', assignee: 'charlie', dueInDays: 12, labels: ['frontend'] },
  { column: 'To Do', title: 'Set up error monitoring', description: 'Capture unhandled client errors and server 5xx responses with release tags.', priority: 'high', assignee: null, dueInDays: 7, labels: ['ops'] },
  { column: 'In Progress', title: 'Implement authentication', description: 'Email + password sign-in with HTTP-only session cookies, logout everywhere and rate-limited login.', priority: 'urgent', assignee: 'alice', dueInDays: 2, labels: ['backend', 'security'] },
  { column: 'In Progress', title: 'Design dashboard', description: 'High-fidelity mock-ups for the workspace overview in light and dark mode.', priority: 'high', assignee: 'charlie', dueInDays: 4, labels: ['design'] },
  { column: 'In Progress', title: 'Configure CI/CD', description: 'Lint, type-check, unit and integration tests on every push; build Docker images on main.', priority: 'high', assignee: 'bob', dueInDays: 1, labels: ['ops'] },
  { column: 'In Progress', title: 'Realtime presence indicators', description: 'Show who is viewing the board. Multiple tabs from the same person count once.', priority: 'medium', assignee: 'alice', dueInDays: 5, labels: ['frontend', 'realtime'] },
  { column: 'Done', title: 'Database schema and migrations', description: 'Users, boards, members, columns, tasks and activity with foreign keys and ordering constraints.', priority: 'high', assignee: 'bob', dueInDays: -4, labels: ['backend'] },
  { column: 'Done', title: 'Brand identity and logo', description: 'Final logo, colour palette and typography (Inter).', priority: 'medium', assignee: 'charlie', dueInDays: -9, labels: ['design'] },
  { column: 'Done', title: 'Project kickoff', description: 'Agree on scope, milestones and owners for the launch.', priority: 'low', assignee: 'alice', dueInDays: -14, labels: ['planning'] },
  { column: 'Done', title: 'Competitor research', description: 'Summarise how Trello, Linear and Height handle real-time collaboration and conflicts.', priority: 'low', assignee: 'bob', dueInDays: -11, labels: ['research', 'product'] },
];

export function isoDateInDays(days: number, from = new Date()): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
  return date.toISOString().slice(0, 10);
}
