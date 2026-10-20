import type { BoardSnapshot, Task, TaskEvent, TaskMutationResult, TaskMutationSuccess } from '@syncboard/shared';

export const BOARD_ID = '5b0a2d5e-3c1f-4d2a-9a47-7f1c0d9e5a11';
export const TODO = 'col-todo';
export const DOING = 'col-doing';
export const USER = 'user-alice';

export function task(id: string, columnId: string, position: number, extra: Partial<Task> = {}): Task {
  return {
    id,
    boardId: BOARD_ID,
    columnId,
    title: id.toUpperCase(),
    description: '',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    labels: [],
    position,
    version: 1,
    createdById: USER,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...extra,
  };
}

/** Board at revision `revision` with To Do = [a, b, c] and Doing = [d]. */
export function snapshot(revision = 10, tasks: Task[] = [task('a', TODO, 0), task('b', TODO, 1), task('c', TODO, 2), task('d', DOING, 0)]): BoardSnapshot {
  return {
    board: { id: BOARD_ID, name: 'Board', description: '', accent: 'indigo', ownerId: USER, revision, createdAt: '', updatedAt: '' },
    columns: [
      { id: TODO, boardId: BOARD_ID, name: 'To Do', position: 0 },
      { id: DOING, boardId: BOARD_ID, name: 'Doing', position: 1 },
    ],
    tasks,
    members: [],
    revision,
    generatedAt: '',
  };
}

const base = (revision: number, mutationId = `m-${revision}`) => ({
  boardId: BOARD_ID,
  revision,
  actorId: 'user-bob',
  mutationId,
  committedAt: '2026-10-20T10:00:00.000Z',
});

export const events = {
  updated: (revision: number, t: Task, mutationId?: string): TaskEvent => ({ type: 'task:updated', ...base(revision, mutationId), task: t }),
  created: (revision: number, t: Task, taskIds: string[], mutationId?: string): TaskEvent => ({
    type: 'task:created',
    ...base(revision, mutationId),
    task: t,
    ordering: { columnId: t.columnId, taskIds },
  }),
  moved: (revision: number, t: Task, fromColumnId: string, orderings: Record<string, string[]>, mutationId?: string): TaskEvent => ({
    type: 'task:moved',
    ...base(revision, mutationId),
    task: t,
    fromColumnId,
    orderings: Object.entries(orderings).map(([columnId, taskIds]) => ({ columnId, taskIds })),
  }),
  deleted: (revision: number, taskId: string, columnId: string, taskIds: string[], mutationId?: string): TaskEvent => ({
    type: 'task:deleted',
    ...base(revision, mutationId),
    taskId,
    columnId,
    ordering: { columnId, taskIds },
  }),
};

export function success(event: TaskEvent, taskAfter: Task | null): TaskMutationSuccess {
  return { success: true, mutationId: event.mutationId, revision: event.revision, duplicate: false, event, task: taskAfter };
}

export type Pending = { event: string; payload: Record<string, unknown>; resolve: (r: TaskMutationResult) => void; reject: (e: unknown) => void };

/** Transport double that records emits and lets the test decide when (and how) each one is answered. */
export class FakeTransport {
  connected = true;
  sent: Pending[] = [];

  isConnected = () => this.connected;

  emit = (event: string, payload: object): Promise<TaskMutationResult> =>
    new Promise((resolve, reject) => {
      this.sent.push({ event, payload: payload as Record<string, unknown>, resolve, reject });
    });

  last(): Pending {
    const pending = this.sent.at(-1);
    if (!pending) throw new Error('nothing sent');
    return pending;
  }
}
