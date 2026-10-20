import type { BoardRole } from '@syncboard/shared';
import { and, eq, sql } from 'drizzle-orm';
import { PG_ERRORS, pgErrorCode, type Database, type Executor, type Transaction } from '../../database/client.js';
import { activityEvents, boardMembers, boards, processedMutations, type BoardRow } from '../../database/schema.js';
import type { ActivityType } from '@syncboard/shared';
import { AppError, errors } from '../../lib/errors.js';

/*
 * The single locking protocol used by EVERY board mutation (tasks, columns, members, board settings):
 *
 *   1. (optional) INSERT the client mutation id into processed_mutations   -> idempotency
 *   2. UPDATE boards SET revision = revision + 1 WHERE id = $board RETURNING *
 *        - takes the board's row lock: concurrent writers of the same board queue here
 *        - allocates the revision number of the event this mutation will publish
 *   3. Re-check membership/role inside the same transaction (no TOCTOU with member removal)
 *   4. Domain work (conditional updates, reordering, activity row)
 *   5. COMMIT, and only then publish the event
 *
 * Because every writer locks the board row before touching tasks, there is one global
 * lock order per board and deadlocks between SyncBoard mutations cannot occur. Any
 * failure rolls back the whole transaction, including the revision increment.
 */

export interface BoardTxContext {
  tx: Transaction;
  board: BoardRow;
  /** Revision allocated to this mutation (board.revision after the increment). */
  revision: number;
  role: BoardRole;
  userId: string;
}

export interface BoardTxOptions {
  boardId: string;
  userId: string;
  minRole?: BoardRole;
}

const ROLE_RANK: Record<BoardRole, number> = { member: 1, owner: 2 };

export async function membershipRole(executor: Executor, boardId: string, userId: string): Promise<BoardRole | null> {
  const [row] = await executor
    .select({ role: boardMembers.role })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** Steps 2-3 of the protocol. Throws BOARD_NOT_FOUND for missing boards and for non-members alike. */
export async function lockBoard(tx: Transaction, { boardId, userId, minRole = 'member' }: BoardTxOptions): Promise<BoardTxContext> {
  const [board] = await tx
    .update(boards)
    .set({ revision: sql`${boards.revision} + 1` })
    .where(eq(boards.id, boardId))
    .returning();
  if (!board) throw errors.boardNotFound();

  const role = await membershipRole(tx, boardId, userId);
  if (!role) throw errors.boardNotFound();
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw errors.forbidden('Only the board owner can do that.');

  return { tx, board, revision: board.revision, role, userId };
}

const TRANSIENT_ERRORS = new Set<string>([PG_ERRORS.serializationFailure, PG_ERRORS.deadlockDetected]);

/**
 * Runs `work` in a READ COMMITTED transaction, retrying a bounded number of times on
 * transient serialization/deadlock failures. With the protocol above these should not
 * occur, but the retry keeps the system safe if a future code path breaks the lock order.
 */
export async function withRetry<T>(db: Database, work: (tx: Transaction) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      const code = pgErrorCode(error);
      if (attempt >= attempts || !code || !TRANSIENT_ERRORS.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
}

export async function runBoardTransaction<T>(
  db: Database,
  options: BoardTxOptions,
  work: (ctx: BoardTxContext) => Promise<T>,
): Promise<T> {
  return withRetry(db, async (tx) => work(await lockBoard(tx, options)));
}

// ---------------------------------------------------------------------------
// Idempotency ledger (step 1)
// ---------------------------------------------------------------------------

export type ClaimResult<R> = { claimed: true } | { claimed: false; result: R };

/**
 * Claims a mutation id inside the current transaction. If another transaction holds an
 * uncommitted claim on the same id, PostgreSQL blocks this INSERT until that transaction
 * finishes, so a retry racing its original can never execute twice.
 */
export async function claimMutation<R>(
  tx: Transaction,
  claim: { mutationId: string; userId: string; boardId: string; kind: string },
): Promise<ClaimResult<R>> {
  const inserted = await tx
    .insert(processedMutations)
    .values({ id: claim.mutationId, userId: claim.userId, boardId: claim.boardId, kind: claim.kind })
    .onConflictDoNothing({ target: processedMutations.id })
    .returning({ id: processedMutations.id });
  if (inserted.length > 0) return { claimed: true };

  const [existing] = await tx.select().from(processedMutations).where(eq(processedMutations.id, claim.mutationId)).limit(1);
  if (!existing || existing.userId !== claim.userId || existing.kind !== claim.kind || existing.result === null) {
    throw new AppError('VALIDATION_ERROR', 'This mutation id has already been used for a different request.');
  }
  return { claimed: false, result: existing.result as R };
}

export async function storeMutationResult(tx: Transaction, mutationId: string, result: unknown): Promise<void> {
  await tx.update(processedMutations).set({ result }).where(eq(processedMutations.id, mutationId));
}

// ---------------------------------------------------------------------------
// Activity (written in the same transaction as the change it describes)
// ---------------------------------------------------------------------------

export async function recordActivity(
  ctx: BoardTxContext,
  entry: { actionType: ActivityType; taskId?: string | null; payload: Record<string, unknown> },
): Promise<void> {
  await ctx.tx.insert(activityEvents).values({
    boardId: ctx.board.id,
    taskId: entry.taskId ?? null,
    actorId: ctx.userId,
    actionType: entry.actionType,
    payload: entry.payload,
    revision: ctx.revision,
  });
}
