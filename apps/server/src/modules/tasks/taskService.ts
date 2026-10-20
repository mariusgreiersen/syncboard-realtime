import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  clampIndex,
  computeMove,
  insertAt,
  positionChanges,
  type CreateTaskInput,
  type DeleteTaskInput,
  type MoveTaskInput,
  type Task,
  type TaskEvent,
  type TaskMutationSuccess,
  type UpdateTaskInput,
} from '@syncboard/shared';
import { and, asc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { PG_ERRORS, pgConstraint, pgErrorCode, type Database, type Executor, type Transaction } from '../../database/client.js';
import { boardMembers, columns, tasks, users } from '../../database/schema.js';
import { AppError, errors } from '../../lib/errors.js';
import type { Log } from '../../lib/logger.js';
import { toTask } from '../../lib/serialize.js';
import {
  claimMutation,
  lockBoard,
  membershipRole,
  recordActivity,
  storeMutationResult,
  withRetry,
  type BoardTxContext,
} from '../mutations/boardTransaction.js';
import type { BoardPublisher } from '../mutations/publisher.js';

type Kind = 'task.create' | 'task.update' | 'task.move' | 'task.delete';

interface Actor {
  id: string;
}

/**
 * Application service for task mutations. Both the REST routes and the Socket.IO
 * handlers call these methods, so validation, authorization, concurrency control and
 * broadcasting are implemented exactly once.
 */
export class TaskService {
  constructor(
    private readonly db: Database,
    private readonly publisher: BoardPublisher,
    private readonly log: Log,
  ) {}

  async getTask(userId: string, taskId: string): Promise<Task> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!row || !(await membershipRole(this.db, row.boardId, userId))) throw errors.taskNotFound();
    return toTask(row);
  }

  /** Resolves the board of a task for REST routes, without revealing tasks of other boards. */
  async boardIdOfTask(userId: string, taskId: string): Promise<string> {
    return (await this.getTask(userId, taskId)).boardId;
  }

  createTask(actor: Actor, input: CreateTaskInput, mutationId: string = randomUUID()): Promise<TaskMutationSuccess> {
    return this.run(actor, input.boardId, mutationId, 'task.create', async (ctx) => {
      const { tx } = ctx;
      await requireColumn(tx, input.boardId, input.columnId);

      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.boardId, input.boardId));
      if (count >= LIMITS.tasksPerBoard) throw errors.limit(`A board can hold at most ${LIMITS.tasksPerBoard} tasks.`);

      if (input.assigneeId) await requireMember(tx, input.boardId, input.assigneeId);

      const ids = await columnTaskIds(tx, input.columnId);
      const index = clampIndex(input.index ?? ids.length, ids.length);
      // Open a slot. The deferred unique constraint tolerates the transient overlap.
      await tx
        .update(tasks)
        .set({ position: sql`${tasks.position} + 1` })
        .where(and(eq(tasks.columnId, input.columnId), gte(tasks.position, index)));

      const [row] = await tx
        .insert(tasks)
        .values({
          id: input.taskId ?? randomUUID(),
          boardId: input.boardId,
          columnId: input.columnId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          assigneeId: input.assigneeId,
          dueDate: input.dueDate,
          labels: input.labels,
          position: index,
          createdById: actor.id,
        })
        .returning();
      const task = toTask(row!);

      await recordActivity(ctx, { actionType: 'task.created', taskId: task.id, payload: { title: task.title, column: await columnName(tx, task.columnId) } });
      return {
        task,
        event: {
          type: 'task:created',
          ...eventBase(ctx, mutationId),
          task,
          ordering: { columnId: task.columnId, taskIds: insertAt(ids, task.id, index) },
        },
      };
    });
  }

  updateTask(actor: Actor, input: UpdateTaskInput, mutationId: string = randomUUID()): Promise<TaskMutationSuccess> {
    return this.run(actor, input.boardId, mutationId, 'task.update', async (ctx) => {
      const { tx } = ctx;
      const { changes } = input;
      if (changes.assigneeId) await requireMember(tx, input.boardId, changes.assigneeId);

      // Optimistic concurrency control: a single conditional UPDATE. The version check and
      // the write are one atomic statement, so two updates based on the same version can
      // never both succeed.
      const [row] = await tx
        .update(tasks)
        .set({ ...changes, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.boardId, input.boardId), eq(tasks.version, input.expectedVersion)))
        .returning();
      if (!row) throw await conflictOrNotFound(tx, input.boardId, input.taskId);
      const task = toTask(row);

      const payload: Record<string, unknown> = { title: task.title, fields: Object.keys(changes) };
      if ('assigneeId' in changes) payload.assignee = changes.assigneeId ? await userName(tx, changes.assigneeId) : null;
      await recordActivity(ctx, { actionType: 'task.updated', taskId: task.id, payload });

      return { task, event: { type: 'task:updated', ...eventBase(ctx, mutationId), task } };
    });
  }

  moveTask(actor: Actor, input: MoveTaskInput, mutationId: string = randomUUID()): Promise<TaskMutationSuccess> {
    return this.run(actor, input.boardId, mutationId, 'task.move', async (ctx) => {
      const { tx } = ctx;
      const [current] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.boardId, input.boardId)))
        .limit(1);
      if (!current) throw errors.taskNotFound();
      await requireColumn(tx, input.boardId, input.toColumnId);

      const fromColumnId = current.columnId;
      const affected = fromColumnId === input.toColumnId ? [fromColumnId] : [fromColumnId, input.toColumnId];
      const rows = await tx
        .select({ id: tasks.id, columnId: tasks.columnId, position: tasks.position })
        .from(tasks)
        .where(inArray(tasks.columnId, affected))
        .orderBy(asc(tasks.position));
      const lists: Record<string, string[]> = Object.fromEntries(affected.map((id) => [id, [] as string[]]));
      for (const r of rows) lists[r.columnId]!.push(r.id);

      const newLists = computeMove(lists, input.taskId, fromColumnId, input.toColumnId, input.toIndex);
      const newPosition = newLists[input.toColumnId]!.indexOf(input.taskId);

      // Conditional update of the moved task (column, position and version together).
      const [moved] = await tx
        .update(tasks)
        .set({ columnId: input.toColumnId, position: newPosition, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.version, input.expectedVersion)))
        .returning();
      if (!moved) throw errors.versionConflict(toTask(current));

      // Renumber siblings densely. Only rows whose position actually changes are written.
      const siblings = rows.filter((r) => r.id !== input.taskId);
      // Sibling positions are their index in the new list (which includes the moved task).
      const changes = Object.values(newLists)
        .flatMap((ids) => positionChanges(siblings, ids))
        .filter((change) => change.id !== input.taskId);
      await applyPositions(tx, changes);

      const task = toTask(moved);
      const fromName = await columnName(tx, fromColumnId);
      const toName = await columnName(tx, input.toColumnId);
      await recordActivity(ctx, { actionType: 'task.moved', taskId: task.id, payload: { title: task.title, from: fromName, to: toName } });

      return {
        task,
        event: {
          type: 'task:moved',
          ...eventBase(ctx, mutationId),
          task,
          fromColumnId,
          orderings: Object.entries(newLists).map(([columnId, taskIds]) => ({ columnId, taskIds })),
        },
      };
    });
  }

  deleteTask(actor: Actor, input: DeleteTaskInput, mutationId: string = randomUUID()): Promise<TaskMutationSuccess> {
    return this.run(actor, input.boardId, mutationId, 'task.delete', async (ctx) => {
      const { tx } = ctx;
      const [current] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.boardId, input.boardId)))
        .limit(1);
      if (!current) throw errors.taskNotFound();
      if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        throw errors.versionConflict(toTask(current));
      }

      await tx.delete(tasks).where(eq(tasks.id, current.id));
      // Close the gap left in the column.
      await tx
        .update(tasks)
        .set({ position: sql`${tasks.position} - 1` })
        .where(and(eq(tasks.columnId, current.columnId), gt(tasks.position, current.position)));

      await recordActivity(ctx, { actionType: 'task.deleted', taskId: current.id, payload: { title: current.title } });
      return {
        task: null,
        event: {
          type: 'task:deleted',
          ...eventBase(ctx, mutationId),
          taskId: current.id,
          columnId: current.columnId,
          ordering: { columnId: current.columnId, taskIds: await columnTaskIds(tx, current.columnId) },
        },
      };
    });
  }

  /**
   * Shared pipeline: idempotency claim → board lock + membership → work → store result →
   * COMMIT → publish. Duplicate mutation ids return the stored result without re-executing.
   */
  private async run(
    actor: Actor,
    boardId: string,
    mutationId: string,
    kind: Kind,
    work: (ctx: BoardTxContext) => Promise<{ task: Task | null; event: TaskEvent }>,
  ): Promise<TaskMutationSuccess> {
    const started = performance.now();
    let outcome: { result: TaskMutationSuccess; duplicate: boolean };
    try {
      outcome = await withRetry(this.db, async (tx) => {
        const claim = await claimMutation<TaskMutationSuccess>(tx, { mutationId, userId: actor.id, boardId, kind });
        if (!claim.claimed) return { result: { ...claim.result, duplicate: true }, duplicate: true };

        const ctx = await lockBoard(tx, { boardId, userId: actor.id });
        const { task, event } = await work(ctx);
        const result: TaskMutationSuccess = { success: true, mutationId, revision: ctx.revision, duplicate: false, event, task };
        await storeMutationResult(tx, mutationId, result);
        return { result, duplicate: false };
      });
    } catch (error) {
      const mapped = mapDatabaseError(error);
      const fields = { event: 'mutation.rejected', kind, mutationId, boardId, userId: actor.id, code: mapped.code, durationMs: elapsed(started) };
      if (mapped.code === 'VERSION_CONFLICT') this.log.info({ ...fields, event: 'mutation.conflict', currentVersion: mapped.currentVersion }, 'version conflict detected');
      else if (mapped instanceof AppError && mapped.code !== 'DATABASE_ERROR') this.log.info(fields, 'mutation rejected');
      else this.log.error({ ...fields, err: error }, 'mutation failed');
      throw mapped;
    }

    const { result, duplicate } = outcome;
    const taskId = result.task?.id ?? (result.event.type === 'task:deleted' ? result.event.taskId : undefined);
    this.log.info(
      { event: duplicate ? 'mutation.duplicate' : 'mutation.committed', kind, mutationId, boardId, taskId, userId: actor.id, revision: result.revision, durationMs: elapsed(started) },
      duplicate ? 'duplicate mutation answered from ledger' : 'mutation committed',
    );
    // Broadcast strictly after COMMIT, and never re-broadcast a duplicate.
    if (!duplicate) this.publisher.publish(result.event);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const elapsed = (started: number) => Math.round((performance.now() - started) * 10) / 10;

function eventBase(ctx: BoardTxContext, mutationId: string) {
  return { boardId: ctx.board.id, revision: ctx.revision, actorId: ctx.userId, mutationId, committedAt: new Date().toISOString() };
}

async function applyPositions(tx: Transaction, changes: Array<{ id: string; position: number }>): Promise<void> {
  if (changes.length === 0) return;
  const values = sql.join(
    changes.map((change) => sql`(${change.id}::uuid, ${change.position}::int)`),
    sql`, `,
  );
  await tx.execute(sql`UPDATE tasks AS t SET position = v.position FROM (VALUES ${values}) AS v(id, position) WHERE t.id = v.id`);
}

async function columnTaskIds(executor: Executor, columnId: string): Promise<string[]> {
  const rows = await executor.select({ id: tasks.id }).from(tasks).where(eq(tasks.columnId, columnId)).orderBy(asc(tasks.position));
  return rows.map((row) => row.id);
}

async function requireColumn(executor: Executor, boardId: string, columnId: string): Promise<void> {
  const [row] = await executor
    .select({ id: columns.id })
    .from(columns)
    .where(and(eq(columns.id, columnId), eq(columns.boardId, boardId)))
    .limit(1);
  if (!row) throw errors.columnNotFound();
}

async function requireMember(executor: Executor, boardId: string, userId: string): Promise<void> {
  const [row] = await executor
    .select({ id: boardMembers.id })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
    .limit(1);
  if (!row) throw new AppError('VALIDATION_ERROR', 'Tasks can only be assigned to board members.', { issues: [{ path: 'assigneeId', message: 'Not a board member' }] });
}

async function columnName(executor: Executor, columnId: string): Promise<string | null> {
  const [row] = await executor.select({ name: columns.name }).from(columns).where(eq(columns.id, columnId)).limit(1);
  return row?.name ?? null;
}

async function userName(executor: Executor, userId: string): Promise<string | null> {
  const [row] = await executor.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name ?? null;
}

async function conflictOrNotFound(tx: Transaction, boardId: string, taskId: string): Promise<AppError> {
  const [current] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.boardId, boardId)))
    .limit(1);
  return current ? errors.versionConflict(toTask(current)) : errors.taskNotFound();
}

function mapDatabaseError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = pgErrorCode(error);
  if (code === PG_ERRORS.uniqueViolation && pgConstraint(error) === 'tasks_pkey') {
    return errors.conflict('A task with this id already exists.');
  }
  if (code === PG_ERRORS.foreignKeyViolation) return errors.conflict('A referenced record no longer exists. Refresh the board and try again.');
  return new AppError('DATABASE_ERROR', 'The change could not be saved. Please try again.');
}
