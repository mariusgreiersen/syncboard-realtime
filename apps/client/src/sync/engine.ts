import {
  insertAt,
  removeId,
  type Board,
  type BoardEvent,
  type BoardMember,
  type BoardSnapshot,
  type Column,
  type Task,
  type TaskChanges,
  type TaskEvent,
} from '@syncboard/shared';

/*
 * Pure synchronisation engine (no React, no sockets) shared by the UI and the tests.
 *
 *   confirmed state  = last authoritative snapshot + task events applied in strict revision order
 *   displayed state  = confirmed state with the user's pending (unconfirmed) mutations re-applied on top
 *
 * Because the optimistic layer is recomputed from confirmed state, a rejected mutation is
 * simply dropped: the view falls back to the latest confirmed state, which already contains
 * every collaborator's committed changes. Nothing is "rolled back" to an old local copy.
 */

export interface BoardState {
  board: Board;
  columns: Column[];
  columnTaskIds: Record<string, string[]>;
  tasks: Record<string, Task>;
  members: BoardMember[];
  revision: number;
}

export function fromSnapshot(snapshot: BoardSnapshot): BoardState {
  const columnTaskIds: Record<string, string[]> = {};
  for (const column of snapshot.columns) columnTaskIds[column.id] = [];
  const tasks: Record<string, Task> = {};
  for (const task of snapshot.tasks) {
    tasks[task.id] = task;
    (columnTaskIds[task.columnId] ??= []).push(task.id);
  }
  for (const ids of Object.values(columnTaskIds)) ids.sort((a, b) => tasks[a]!.position - tasks[b]!.position);
  return {
    board: snapshot.board,
    columns: [...snapshot.columns].sort((a, b) => a.position - b.position),
    columnTaskIds,
    tasks,
    members: snapshot.members,
    revision: snapshot.revision,
  };
}

/** Applies one committed task event. The caller guarantees `event.revision === state.revision + 1`. */
export function applyEvent(state: BoardState, event: TaskEvent): BoardState {
  const tasks = { ...state.tasks };
  const columnTaskIds = { ...state.columnTaskIds };
  switch (event.type) {
    case 'task:created':
    case 'task:updated':
      tasks[event.task.id] = event.task;
      if (event.type === 'task:created') columnTaskIds[event.ordering.columnId] = event.ordering.taskIds;
      break;
    case 'task:moved':
      tasks[event.task.id] = event.task;
      for (const ordering of event.orderings) columnTaskIds[ordering.columnId] = ordering.taskIds;
      break;
    case 'task:deleted':
      delete tasks[event.taskId];
      columnTaskIds[event.ordering.columnId] = event.ordering.taskIds;
      break;
  }
  return { ...state, tasks, columnTaskIds, revision: event.revision };
}

// ---------------------------------------------------------------------------
// Ordered event intake: dedupe, buffer out-of-order events, detect gaps
// ---------------------------------------------------------------------------

export interface SyncState {
  confirmed: BoardState | null;
  /** Events that arrived ahead of a missing revision, keyed by revision. */
  buffer: Record<number, BoardEvent>;
  /** True when the client knows it must fetch a snapshot (sync-required or unrecoverable gap). */
  needsSnapshot: boolean;
}

export type EventOutcome = 'applied' | 'duplicate' | 'buffered' | 'resync';

export const emptySync = (): SyncState => ({ confirmed: null, buffer: {}, needsSnapshot: false });

function drain(sync: SyncState): SyncState {
  let { confirmed } = sync;
  if (!confirmed) return sync;
  const buffer = { ...sync.buffer };
  let needsSnapshot = sync.needsSnapshot;
  for (;;) {
    const next = buffer[confirmed.revision + 1];
    if (!next) break;
    if (next.type === 'board:sync-required') {
      needsSnapshot = true; // cannot apply structurally; wait for a snapshot at or after this revision
      break;
    }
    delete buffer[next.revision];
    confirmed = applyEvent(confirmed, next);
  }
  return { confirmed, buffer, needsSnapshot };
}

export function receiveEvent(sync: SyncState, event: BoardEvent): { sync: SyncState; outcome: EventOutcome } {
  if (event.type === 'board:sync-required') {
    if (event.revision !== null && sync.confirmed && event.revision <= sync.confirmed.revision) {
      return { sync, outcome: 'duplicate' };
    }
    const buffer = event.revision !== null ? { ...sync.buffer, [event.revision]: event } : sync.buffer;
    return { sync: { ...sync, buffer, needsSnapshot: true }, outcome: 'resync' };
  }

  if (!sync.confirmed) {
    return { sync: { ...sync, buffer: { ...sync.buffer, [event.revision]: event } }, outcome: 'buffered' };
  }
  if (event.revision <= sync.confirmed.revision || sync.buffer[event.revision]) {
    return { sync, outcome: 'duplicate' };
  }
  if (event.revision === sync.confirmed.revision + 1) {
    return { sync: drain({ ...sync, confirmed: applyEvent(sync.confirmed, event) }), outcome: 'applied' };
  }
  return { sync: { ...sync, buffer: { ...sync.buffer, [event.revision]: event } }, outcome: 'buffered' };
}

/** Accepts a snapshot unless it is older than the confirmed state (stale responses are ignored). */
export function receiveSnapshot(sync: SyncState, snapshot: BoardSnapshot): { sync: SyncState; outcome: 'applied' | 'stale' } {
  if (sync.confirmed && snapshot.revision < sync.confirmed.revision) return { sync, outcome: 'stale' };
  const buffer: Record<number, BoardEvent> = {};
  for (const [revision, event] of Object.entries(sync.buffer)) {
    if (Number(revision) > snapshot.revision) buffer[Number(revision)] = event;
  }
  return { sync: drain({ confirmed: fromSnapshot(snapshot), buffer, needsSnapshot: false }), outcome: 'applied' };
}

/** True when buffered events are waiting for a revision that has not arrived. */
export function hasGap(sync: SyncState): boolean {
  if (!sync.confirmed) return false;
  return Object.keys(sync.buffer).some((revision) => Number(revision) > sync.confirmed!.revision);
}

// ---------------------------------------------------------------------------
// Optimistic layer
// ---------------------------------------------------------------------------

export type PendingMutation =
  | { kind: 'create'; mutationId: string; task: Task; index: number }
  | { kind: 'update'; mutationId: string; taskId: string; changes: TaskChanges }
  | { kind: 'move'; mutationId: string; taskId: string; toColumnId: string; toIndex: number }
  | { kind: 'delete'; mutationId: string; taskId: string };

export const pendingTaskId = (mutation: PendingMutation): string => (mutation.kind === 'create' ? mutation.task.id : mutation.taskId);

function columnOf(state: BoardState, taskId: string): string | undefined {
  const task = state.tasks[taskId];
  if (task && state.columnTaskIds[task.columnId]?.includes(taskId)) return task.columnId;
  return Object.keys(state.columnTaskIds).find((columnId) => state.columnTaskIds[columnId]!.includes(taskId));
}

/** Applies one optimistic mutation. Idempotent: re-applying a mutation that is already reflected changes nothing. */
export function applyPendingOne(state: BoardState, mutation: PendingMutation): BoardState {
  switch (mutation.kind) {
    case 'create': {
      const { task } = mutation;
      if (state.tasks[task.id] || !state.columnTaskIds[task.columnId]) return state;
      return {
        ...state,
        tasks: { ...state.tasks, [task.id]: task },
        columnTaskIds: { ...state.columnTaskIds, [task.columnId]: insertAt(state.columnTaskIds[task.columnId]!, task.id, mutation.index) },
      };
    }
    case 'update': {
      const task = state.tasks[mutation.taskId];
      if (!task) return state;
      return { ...state, tasks: { ...state.tasks, [task.id]: { ...task, ...mutation.changes } } };
    }
    case 'move': {
      const task = state.tasks[mutation.taskId];
      const from = columnOf(state, mutation.taskId);
      if (!task || !from || !state.columnTaskIds[mutation.toColumnId]) return state;
      const columnTaskIds = { ...state.columnTaskIds, [from]: removeId(state.columnTaskIds[from]!, task.id) };
      columnTaskIds[mutation.toColumnId] = insertAt(columnTaskIds[mutation.toColumnId]!, task.id, mutation.toIndex);
      return { ...state, columnTaskIds, tasks: { ...state.tasks, [task.id]: { ...task, columnId: mutation.toColumnId } } };
    }
    case 'delete': {
      const from = columnOf(state, mutation.taskId);
      if (!state.tasks[mutation.taskId]) return state;
      const tasks = { ...state.tasks };
      delete tasks[mutation.taskId];
      return { ...state, tasks, columnTaskIds: from ? { ...state.columnTaskIds, [from]: removeId(state.columnTaskIds[from]!, mutation.taskId) } : state.columnTaskIds };
    }
  }
}

export function applyPending(state: BoardState, pending: readonly PendingMutation[]): BoardState {
  return pending.reduce(applyPendingOne, state);
}

/** Ordered task ids per column, the shape the Kanban UI renders. */
export function columnTasks(state: BoardState, columnId: string): Task[] {
  return (state.columnTaskIds[columnId] ?? []).map((id) => state.tasks[id]).filter((task): task is Task => Boolean(task));
}
