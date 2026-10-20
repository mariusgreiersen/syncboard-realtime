import type {
  BoardEvent,
  BoardSnapshot,
  CreateTaskMutation,
  DeleteTaskMutation,
  ErrorCode,
  MoveTaskMutation,
  Priority,
  Task,
  TaskChanges,
  TaskMutationEventName,
  TaskMutationResult,
  UpdateTaskMutation,
} from '@syncboard/shared';
import {
  applyPending,
  emptySync,
  hasGap,
  pendingTaskId,
  receiveEvent,
  receiveSnapshot,
  type BoardState,
  type PendingMutation,
  type SyncState,
} from './engine';

/*
 * Mutation lifecycle on top of the pure engine:
 *
 *  - Every mutation gets a client-generated mutation id and is applied optimistically.
 *  - Mutations of the same task are chained: the next one is sent only after the previous
 *    one is confirmed, using the version the server returned as its expected version.
 *  - Confirmation arrives either as the acknowledgement or as the broadcast event carrying
 *    the same mutation id (whichever comes first). Both paths are idempotent.
 *  - An acknowledgement timeout does not mean the mutation failed. It is retried with the
 *    SAME mutation id; the server's idempotency ledger guarantees it executes at most once.
 *  - On disconnect, in-flight mutations wait; after the reconnect snapshot they are resent
 *    (again with the same ids). New mutations are refused while offline.
 *  - Rejections drop the mutation from the optimistic layer and request a snapshot.
 */

export interface MutationTransport {
  isConnected(): boolean;
  /** Emits with an acknowledgement. Rejects with AckTimeoutError when no ack arrives in time. */
  emit(event: TaskMutationEventName, payload: object, timeoutMs: number): Promise<TaskMutationResult>;
}

export class AckTimeoutError extends Error {
  constructor() {
    super('Acknowledgement timed out');
    this.name = 'AckTimeoutError';
  }
}

export type NoticeType = 'conflict' | 'rejected' | 'timeout' | 'offline';

export interface SyncNotice {
  type: NoticeType;
  message: string;
  code: ErrorCode;
  taskId?: string;
  mutationId?: string;
  currentTask?: Task | null;
}

export type MutationOutcome =
  | { ok: true; task: Task | null; revision: number }
  | { ok: false; code: ErrorCode; message: string; currentTask?: Task | null };

/**
 * queued             waiting for an earlier mutation of the same task
 * in-flight          sent, waiting for the acknowledgement / broadcast
 * awaiting-reconnect connection dropped before confirmation; resent after the next snapshot
 * settled            confirmed by the server, kept in the optimistic layer only until the
 *                    confirmed state has caught up to its revision (avoids flicker during gaps)
 */
export type PendingStatus = 'queued' | 'in-flight' | 'awaiting-reconnect' | 'settled';

export interface PendingInfo {
  mutationId: string;
  kind: PendingMutation['kind'];
  taskId: string;
  status: PendingStatus;
  attempt: number;
  createdAt: number;
}

export interface SyncStats {
  eventsApplied: number;
  duplicatesIgnored: number;
  gapsDetected: number;
  snapshotsApplied: number;
  staleSnapshotsIgnored: number;
  conflicts: number;
  failures: number;
  retries: number;
  lastEvent: { type: BoardEvent['type']; revision: number | null; at: number } | null;
  lastSnapshotAt: number | null;
}

export interface ControllerState {
  sync: SyncState;
  view: BoardState | null;
  pending: PendingInfo[];
  stats: SyncStats;
}

interface PendingEntry {
  mutation: PendingMutation;
  status: PendingStatus;
  baseVersion: number | null;
  attempt: number;
  createdAt: number;
  settledRevision?: number;
  resolve: (outcome: MutationOutcome) => void;
}

export interface ControllerOptions {
  userId: string;
  ackTimeoutMs?: number;
  /** How long buffered out-of-order events may wait for a missing revision before resyncing. */
  gapTimeoutMs?: number;
  maxAttempts?: number;
  generateId?: () => string;
  now?: () => number;
}

export interface ControllerHooks {
  requestSnapshot(reason: string): void;
  notify(notice: SyncNotice): void;
}

const RESYNC_CODES = new Set<ErrorCode>(['VERSION_CONFLICT', 'TASK_NOT_FOUND', 'COLUMN_NOT_FOUND', 'BOARD_NOT_FOUND', 'FORBIDDEN', 'TIMEOUT', 'INTERNAL_ERROR', 'DATABASE_ERROR', 'CONFLICT']);

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  VERSION_CONFLICT: 'This task was changed by another collaborator. The board has been refreshed.',
  TASK_NOT_FOUND: 'That task no longer exists. The board has been refreshed.',
  COLUMN_NOT_FOUND: 'That column no longer exists. The board has been refreshed.',
  TIMEOUT: 'SyncBoard could not confirm your change. The board has been refreshed.',
};

export interface CreateTaskDraft {
  columnId: string;
  title: string;
  description?: string;
  priority?: Priority;
  assigneeId?: string | null;
  dueDate?: string | null;
  labels?: string[];
  index?: number;
}

export class BoardSyncController {
  private sync: SyncState = emptySync();
  private entries: PendingEntry[] = [];
  private view: BoardState | null = null;
  private stats: SyncStats = {
    eventsApplied: 0,
    duplicatesIgnored: 0,
    gapsDetected: 0,
    snapshotsApplied: 0,
    staleSnapshotsIgnored: 0,
    conflicts: 0,
    failures: 0,
    retries: 0,
    lastEvent: null,
    lastSnapshotAt: null,
  };
  private state: ControllerState;
  private readonly listeners = new Set<() => void>();
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly options: Required<ControllerOptions>;

  constructor(
    readonly boardId: string,
    private readonly transport: MutationTransport,
    private readonly hooks: ControllerHooks,
    options: ControllerOptions,
  ) {
    this.options = {
      ackTimeoutMs: 8_000,
      gapTimeoutMs: 1_500,
      maxAttempts: 3,
      generateId: () => crypto.randomUUID(),
      now: Date.now,
      ...options,
    };
    this.state = this.buildState();
  }

  // --- observable -----------------------------------------------------------

  getState = (): ControllerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private buildState(): ControllerState {
    return {
      sync: this.sync,
      view: this.view,
      pending: this.entries.map((entry) => ({
        mutationId: entry.mutation.mutationId,
        kind: entry.mutation.kind,
        taskId: pendingTaskId(entry.mutation),
        status: entry.status,
        attempt: entry.attempt,
        createdAt: entry.createdAt,
      })),
      stats: { ...this.stats },
    };
  }

  private commit(): void {
    if (this.disposed) return;
    const confirmedRevision = this.sync.confirmed?.revision ?? -1;
    this.entries = this.entries.filter((entry) => entry.status !== 'settled' || (entry.settledRevision ?? 0) > confirmedRevision);
    this.view = this.sync.confirmed ? applyPending(this.sync.confirmed, this.entries.map((entry) => entry.mutation)) : null;
    this.state = this.buildState();
    for (const listener of this.listeners) listener();
  }

  // --- inbound --------------------------------------------------------------

  receiveSnapshot(snapshot: BoardSnapshot): void {
    if (snapshot.board.id !== this.boardId) return;
    const { sync, outcome } = receiveSnapshot(this.sync, snapshot);
    if (outcome === 'stale') {
      this.stats.staleSnapshotsIgnored++;
      this.commit();
      return;
    }
    this.sync = sync;
    this.stats.snapshotsApplied++;
    this.stats.lastSnapshotAt = this.options.now();
    this.clearGapTimer();
    // Mutations interrupted by a disconnect are resent with their original ids.
    if (this.transport.isConnected()) {
      for (const entry of this.entries) {
        if (entry.status === 'awaiting-reconnect') this.send(entry);
      }
    }
    this.afterIntake();
    this.commit();
  }

  receiveEvent(event: BoardEvent): void {
    if (event.boardId !== this.boardId) return;
    this.ingest(event);
    this.afterIntake();
    this.commit();
  }

  private ingest(event: BoardEvent): void {
    const { sync, outcome } = receiveEvent(this.sync, event);
    this.sync = sync;
    this.stats.lastEvent = { type: event.type, revision: event.revision, at: this.options.now() };
    if (outcome === 'applied') this.stats.eventsApplied++;
    if (outcome === 'duplicate') this.stats.duplicatesIgnored++;
    if (event.type === 'board:sync-required') return;

    // A broadcast of our own mutation confirms it, even if the acknowledgement is late or lost.
    const entry = this.findEntry(event.mutationId);
    if (entry && entry.status !== 'queued' && entry.status !== 'settled') {
      this.complete(entry, event.type === 'task:deleted' ? null : event.task, event.revision);
    }
  }

  private afterIntake(): void {
    if (this.sync.needsSnapshot) {
      this.hooks.requestSnapshot('sync-required');
      return;
    }
    if (hasGap(this.sync)) {
      if (!this.gapTimer) {
        this.stats.gapsDetected++;
        this.gapTimer = setTimeout(() => {
          this.gapTimer = null;
          if (hasGap(this.sync)) this.hooks.requestSnapshot('revision-gap');
        }, this.options.gapTimeoutMs);
      }
    } else {
      this.clearGapTimer();
    }
  }

  private clearGapTimer(): void {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  // --- connection -----------------------------------------------------------

  /** In-flight acknowledgements cannot arrive over a new connection; park them until the next snapshot. */
  handleDisconnect(): void {
    for (const entry of this.entries) {
      if (entry.status === 'in-flight') entry.status = 'awaiting-reconnect';
    }
    this.commit();
  }

  // --- outbound -------------------------------------------------------------

  createTask(draft: CreateTaskDraft): Promise<MutationOutcome> {
    const confirmed = this.sync.confirmed;
    if (!confirmed) return Promise.resolve(this.refuse('BOARD_NOT_FOUND', 'The board is still loading.'));
    const now = new Date(this.options.now()).toISOString();
    const columnIds = this.view?.columnTaskIds[draft.columnId] ?? [];
    const index = Math.min(draft.index ?? columnIds.length, columnIds.length);
    const task: Task = {
      id: this.options.generateId(),
      boardId: this.boardId,
      columnId: draft.columnId,
      title: draft.title,
      description: draft.description ?? '',
      priority: draft.priority ?? 'medium',
      assigneeId: draft.assigneeId ?? null,
      dueDate: draft.dueDate ?? null,
      labels: draft.labels ?? [],
      position: index,
      version: 1,
      createdById: this.options.userId,
      createdAt: now,
      updatedAt: now,
    };
    return this.dispatch({ kind: 'create', mutationId: this.options.generateId(), task, index }, null);
  }

  updateTask(taskId: string, changes: TaskChanges, expectedVersion?: number): Promise<MutationOutcome> {
    return this.dispatch({ kind: 'update', mutationId: this.options.generateId(), taskId, changes }, expectedVersion ?? null);
  }

  moveTask(taskId: string, toColumnId: string, toIndex: number): Promise<MutationOutcome> {
    return this.dispatch({ kind: 'move', mutationId: this.options.generateId(), taskId, toColumnId, toIndex }, null);
  }

  deleteTask(taskId: string): Promise<MutationOutcome> {
    return this.dispatch({ kind: 'delete', mutationId: this.options.generateId(), taskId }, null);
  }

  private refuse(code: ErrorCode, message: string): MutationOutcome {
    return { ok: false, code, message };
  }

  private dispatch(mutation: PendingMutation, expectedVersion: number | null): Promise<MutationOutcome> {
    if (!this.transport.isConnected()) {
      const message = 'You are offline. Changes are paused until SyncBoard reconnects.';
      this.hooks.notify({ type: 'offline', code: 'DISCONNECTED', message });
      return Promise.resolve(this.refuse('DISCONNECTED', message));
    }
    const taskId = pendingTaskId(mutation);
    const chained = this.entries.some((entry) => entry.status !== 'settled' && pendingTaskId(entry.mutation) === taskId);
    let baseVersion: number | null = null;
    if (mutation.kind !== 'create' && !chained) {
      const confirmedTask = this.sync.confirmed?.tasks[taskId];
      if (!confirmedTask) return Promise.resolve(this.refuse('TASK_NOT_FOUND', MESSAGES.TASK_NOT_FOUND!));
      baseVersion = expectedVersion ?? confirmedTask.version;
    }

    return new Promise<MutationOutcome>((resolve) => {
      const entry: PendingEntry = { mutation, status: 'queued', baseVersion, attempt: 0, createdAt: this.options.now(), resolve };
      this.entries.push(entry);
      if (!chained) this.send(entry);
      this.commit();
    });
  }

  private payloadFor(entry: PendingEntry): [TaskMutationEventName, CreateTaskMutation | UpdateTaskMutation | MoveTaskMutation | DeleteTaskMutation] {
    const { mutation } = entry;
    const expectedVersion = entry.baseVersion ?? this.sync.confirmed?.tasks[pendingTaskId(mutation)]?.version ?? 1;
    switch (mutation.kind) {
      case 'create': {
        const { task } = mutation;
        return [
          'task:create',
          {
            mutationId: mutation.mutationId,
            boardId: this.boardId,
            columnId: task.columnId,
            taskId: task.id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            assigneeId: task.assigneeId,
            dueDate: task.dueDate,
            labels: task.labels,
            index: mutation.index,
          },
        ];
      }
      case 'update':
        return ['task:update', { mutationId: mutation.mutationId, boardId: this.boardId, taskId: mutation.taskId, expectedVersion, changes: mutation.changes }];
      case 'move':
        return ['task:move', { mutationId: mutation.mutationId, boardId: this.boardId, taskId: mutation.taskId, expectedVersion, toColumnId: mutation.toColumnId, toIndex: mutation.toIndex }];
      case 'delete':
        return ['task:delete', { mutationId: mutation.mutationId, boardId: this.boardId, taskId: mutation.taskId, expectedVersion }];
    }
  }

  private send(entry: PendingEntry): void {
    if (!this.transport.isConnected()) {
      entry.status = 'awaiting-reconnect';
      return;
    }
    if (entry.attempt > 0) this.stats.retries++;
    entry.status = 'in-flight';
    entry.attempt++;
    const attempt = entry.attempt;
    const [event, payload] = this.payloadFor(entry);
    const isCurrent = () => this.entries.includes(entry) && entry.attempt === attempt && entry.status === 'in-flight';

    this.transport.emit(event, payload, this.options.ackTimeoutMs).then(
      (result) => {
        if (!isCurrent()) return;
        if (result.success) {
          this.ingest(result.event);
          // ingest() completes the entry when it recognises the mutation id; complete here otherwise.
          if (entry.status === 'in-flight') this.complete(entry, result.task, result.revision);
        } else {
          this.fail(entry, result.code, result.message, result.currentTask);
        }
        this.afterIntake();
        this.commit();
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        if (error instanceof AckTimeoutError && entry.attempt < this.options.maxAttempts) {
          if (this.transport.isConnected()) this.send(entry);
          else entry.status = 'awaiting-reconnect';
        } else {
          this.fail(entry, 'TIMEOUT', MESSAGES.TIMEOUT!);
        }
        this.commit();
      },
    );
  }

  private findEntry(mutationId: string): PendingEntry | undefined {
    return this.entries.find((entry) => entry.mutation.mutationId === mutationId);
  }

  private complete(entry: PendingEntry, task: Task | null, revision: number): void {
    // Stay in the optimistic layer until the confirmed state includes this revision; commit() prunes it.
    entry.status = 'settled';
    entry.settledRevision = revision;
    entry.resolve({ ok: true, task, revision });
    const taskId = pendingTaskId(entry.mutation);
    const next = this.entries.find((candidate) => pendingTaskId(candidate.mutation) === taskId && candidate.status === 'queued');
    if (!next) return;
    if (!task) {
      this.fail(next, 'TASK_NOT_FOUND', MESSAGES.TASK_NOT_FOUND!, null, false);
      return;
    }
    next.baseVersion = task.version;
    this.send(next);
  }

  private fail(entry: PendingEntry, code: ErrorCode, message: string, currentTask?: Task | null, notify = true): void {
    const taskId = pendingTaskId(entry.mutation);
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    entry.resolve({ ok: false, code, message, ...(currentTask !== undefined ? { currentTask } : {}) });
    this.stats.failures++;
    if (code === 'VERSION_CONFLICT') this.stats.conflicts++;

    // Later changes to the same task were based on the rejected one; drop them too.
    const dependants = this.entries.filter((candidate) => pendingTaskId(candidate.mutation) === taskId && candidate.status === 'queued');
    this.entries = this.entries.filter((candidate) => !dependants.includes(candidate));
    for (const dependant of dependants) {
      dependant.resolve({ ok: false, code, message: 'Skipped because an earlier change to this task was rejected.' });
    }

    if (notify) {
      this.hooks.notify({
        type: code === 'VERSION_CONFLICT' ? 'conflict' : code === 'TIMEOUT' ? 'timeout' : 'rejected',
        code,
        message: MESSAGES[code] ?? message,
        taskId,
        mutationId: entry.mutation.mutationId,
        ...(currentTask !== undefined ? { currentTask } : {}),
      });
    }
    if (RESYNC_CODES.has(code)) this.hooks.requestSnapshot(`mutation-${code.toLowerCase()}`);
  }

  dispose(): void {
    this.disposed = true;
    this.clearGapTimer();
    this.listeners.clear();
    for (const entry of this.entries) entry.resolve({ ok: false, code: 'DISCONNECTED', message: 'Board closed.' });
    this.entries = [];
  }
}
