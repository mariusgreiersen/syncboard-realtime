/**
 * Domain models shared by the server and the client.
 * Timestamps are ISO-8601 strings on the wire; due dates are calendar dates (YYYY-MM-DD).
 */

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const BOARD_ROLES = ['owner', 'member'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const BOARD_ACCENTS = ['indigo', 'violet', 'sky', 'emerald', 'amber', 'rose'] as const;
export type BoardAccent = (typeof BOARD_ACCENTS)[number];

export const AVATAR_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#f43f5e',
  '#14b8a6',
  '#64748b',
] as const;

/** A user as visible to the user themself. */
export interface User {
  id: string;
  email: string;
  name: string;
  avatarColor: string;
  isDemo: boolean;
  createdAt: string;
}

/** A user as visible to collaborators. */
export interface PublicUser {
  id: string;
  name: string;
  avatarColor: string;
}

export interface Board {
  id: string;
  name: string;
  description: string;
  accent: BoardAccent;
  ownerId: string;
  /** Monotonic counter incremented by every committed board mutation. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSummary extends Board {
  role: BoardRole;
  taskCount: number;
  memberCount: number;
}

export interface BoardMember extends PublicUser {
  email: string;
  role: BoardRole;
  joinedAt: string;
}

export interface Column {
  id: string;
  boardId: string;
  name: string;
  position: number;
}

export interface Task {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string;
  priority: Priority;
  assigneeId: string | null;
  dueDate: string | null;
  labels: string[];
  position: number;
  /** Optimistic-concurrency version; incremented by every committed change to this task. */
  version: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Authoritative state of a board at one revision. */
export interface BoardSnapshot {
  board: Board;
  /** Columns ordered by position. */
  columns: Column[];
  /** Tasks ordered by (column position, task position). */
  tasks: Task[];
  members: BoardMember[];
  revision: number;
  generatedAt: string;
}

export const ACTIVITY_TYPES = [
  'task.created',
  'task.updated',
  'task.moved',
  'task.deleted',
  'column.created',
  'column.renamed',
  'board.updated',
  'board.reset',
  'member.added',
  'member.removed',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityEvent {
  id: string;
  boardId: string;
  taskId: string | null;
  actor: PublicUser | null;
  actionType: ActivityType;
  payload: Record<string, unknown>;
  revision: number;
  createdAt: string;
}

export interface PresenceUser extends PublicUser {
  /** Number of live socket connections this user has on the board (e.g. browser tabs). */
  connections: number;
}
