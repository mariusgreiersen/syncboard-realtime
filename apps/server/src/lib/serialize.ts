import type { Board, BoardAccent, Column, PublicUser, Task, User } from '@syncboard/shared';
import type { BoardRow, ColumnRow, TaskRow, UserRow } from '../database/schema.js';

export const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  avatarColor: row.avatarColor,
  isDemo: row.isDemo,
  createdAt: row.createdAt.toISOString(),
});

export const toPublicUser = (row: Pick<UserRow, 'id' | 'name' | 'avatarColor'>): PublicUser => ({
  id: row.id,
  name: row.name,
  avatarColor: row.avatarColor,
});

export const toBoard = (row: BoardRow): Board => ({
  id: row.id,
  name: row.name,
  description: row.description,
  accent: row.accent as BoardAccent,
  ownerId: row.ownerId,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toColumn = (row: ColumnRow): Column => ({
  id: row.id,
  boardId: row.boardId,
  name: row.name,
  position: row.position,
});

export const toTask = (row: TaskRow): Task => ({
  id: row.id,
  boardId: row.boardId,
  columnId: row.columnId,
  title: row.title,
  description: row.description,
  priority: row.priority,
  assigneeId: row.assigneeId,
  dueDate: row.dueDate,
  labels: row.labels,
  position: row.position,
  version: row.version,
  createdById: row.createdById,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
