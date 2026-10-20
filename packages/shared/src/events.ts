import type { z } from 'zod';
import type { ErrorCode } from './errors.js';
import type {
  joinBoardSchema,
  leaveBoardSchema,
  socketCreateTaskSchema,
  socketDeleteTaskSchema,
  socketMoveTaskSchema,
  socketUpdateTaskSchema,
} from './schemas.js';
import type { BoardSnapshot, PresenceUser, Task } from './types.js';

/** Socket.IO room naming. One room per board. */
export const boardRoom = (boardId: string): string => `board:${boardId}`;

// ---------------------------------------------------------------------------
// Board events (server → client). Every event carries the board revision it
// produced, so clients can apply events in order, drop duplicates and detect gaps.
// ---------------------------------------------------------------------------

export interface ColumnOrdering {
  columnId: string;
  /** Authoritative task order of the column after the mutation. */
  taskIds: string[];
}

interface BoardEventBase {
  boardId: string;
  revision: number;
  actorId: string;
  mutationId: string;
  committedAt: string;
}

export interface TaskCreatedEvent extends BoardEventBase {
  type: 'task:created';
  task: Task;
  ordering: ColumnOrdering;
}

export interface TaskUpdatedEvent extends BoardEventBase {
  type: 'task:updated';
  task: Task;
}

export interface TaskMovedEvent extends BoardEventBase {
  type: 'task:moved';
  task: Task;
  fromColumnId: string;
  orderings: ColumnOrdering[];
}

export interface TaskDeletedEvent extends BoardEventBase {
  type: 'task:deleted';
  taskId: string;
  columnId: string;
  ordering: ColumnOrdering;
}

export const SYNC_REASONS = [
  'board-updated',
  'board-reset',
  'board-deleted',
  'columns-changed',
  'members-changed',
  'access-revoked',
] as const;
export type SyncReason = (typeof SYNC_REASONS)[number];

/**
 * Sent for changes that have no fine-grained event (column/board/member changes),
 * and when access is revoked. Clients respond by fetching an authoritative snapshot.
 * `revision` is set when the change consumed a board revision.
 */
export interface SyncRequiredEvent {
  type: 'board:sync-required';
  boardId: string;
  revision: number | null;
  reason: SyncReason;
  actorId: string | null;
}

export type TaskEvent = TaskCreatedEvent | TaskUpdatedEvent | TaskMovedEvent | TaskDeletedEvent;
export type BoardEvent = TaskEvent | SyncRequiredEvent;

export interface PresenceUpdatedPayload {
  boardId: string;
  users: PresenceUser[];
}

// ---------------------------------------------------------------------------
// Acknowledgements
// ---------------------------------------------------------------------------

export interface MutationFailure {
  success: false;
  mutationId: string | null;
  code: ErrorCode;
  message: string;
  /** For VERSION_CONFLICT: the authoritative task (null if it was deleted). */
  currentTask?: Task | null;
  currentVersion?: number;
}

export interface TaskMutationSuccess {
  success: true;
  mutationId: string;
  revision: number;
  /** True when the server recognised the mutation id and returned the stored result instead of re-executing. */
  duplicate: boolean;
  event: TaskEvent;
  /** The task after the mutation, or null for deletions. */
  task: Task | null;
}

export type TaskMutationResult = TaskMutationSuccess | MutationFailure;

export type JoinBoardResult =
  | { success: true; boardId: string; revision: number }
  | MutationFailure;

export type LeaveBoardResult = { success: true; boardId: string } | MutationFailure;

// ---------------------------------------------------------------------------
// Typed Socket.IO contracts
// ---------------------------------------------------------------------------

export type JoinBoardPayload = z.input<typeof joinBoardSchema>;
export type LeaveBoardPayload = z.input<typeof leaveBoardSchema>;
export type CreateTaskMutation = z.input<typeof socketCreateTaskSchema>;
export type UpdateTaskMutation = z.input<typeof socketUpdateTaskSchema>;
export type MoveTaskMutation = z.input<typeof socketMoveTaskSchema>;
export type DeleteTaskMutation = z.input<typeof socketDeleteTaskSchema>;

export interface ClientToServerEvents {
  'board:join': (payload: JoinBoardPayload, ack: (result: JoinBoardResult) => void) => void;
  'board:leave': (payload: LeaveBoardPayload, ack: (result: LeaveBoardResult) => void) => void;
  'task:create': (payload: CreateTaskMutation, ack: (result: TaskMutationResult) => void) => void;
  'task:update': (payload: UpdateTaskMutation, ack: (result: TaskMutationResult) => void) => void;
  'task:move': (payload: MoveTaskMutation, ack: (result: TaskMutationResult) => void) => void;
  'task:delete': (payload: DeleteTaskMutation, ack: (result: TaskMutationResult) => void) => void;
}

export interface ServerToClientEvents {
  'board:snapshot': (snapshot: BoardSnapshot) => void;
  'task:created': (event: TaskCreatedEvent) => void;
  'task:updated': (event: TaskUpdatedEvent) => void;
  'task:moved': (event: TaskMovedEvent) => void;
  'task:deleted': (event: TaskDeletedEvent) => void;
  'presence:updated': (payload: PresenceUpdatedPayload) => void;
  'board:sync-required': (event: SyncRequiredEvent) => void;
}

export type TaskMutationEventName = 'task:create' | 'task:update' | 'task:move' | 'task:delete';
