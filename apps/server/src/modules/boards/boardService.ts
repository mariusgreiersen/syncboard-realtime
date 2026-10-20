import {
  LIMITS,
  type Board,
  type BoardMember,
  type BoardRole,
  type BoardSnapshot,
  type BoardSummary,
} from '@syncboard/shared';
import type { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { createBoardSchema, updateBoardSchema } from '@syncboard/shared';
import type { Database, Executor } from '../../database/client.js';
import { boardMembers, boards, columns, tasks, users, type UserRow } from '../../database/schema.js';
import { errors } from '../../lib/errors.js';
import type { Log } from '../../lib/logger.js';
import { toBoard, toColumn, toTask } from '../../lib/serialize.js';
import { membershipRole, recordActivity, runBoardTransaction } from '../mutations/boardTransaction.js';
import type { BoardPublisher } from '../mutations/publisher.js';

export const DEFAULT_COLUMNS = ['Backlog', 'To Do', 'In Progress', 'Done'] as const;

type CreateBoardInput = z.output<typeof createBoardSchema>;
type UpdateBoardInput = z.output<typeof updateBoardSchema>;

export class BoardService {
  constructor(
    private readonly db: Database,
    private readonly publisher: BoardPublisher,
    private readonly log: Log,
  ) {}

  async listBoards(userId: string): Promise<BoardSummary[]> {
    const rows = await this.db
      .select({
        board: boards,
        role: boardMembers.role,
        taskCount: sql<number>`(select count(*)::int from ${tasks} where ${tasks.boardId} = ${boards.id})`,
        memberCount: sql<number>`(select count(*)::int from ${boardMembers} m where m.board_id = ${boards.id})`,
      })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .where(eq(boardMembers.userId, userId))
      .orderBy(desc(boards.updatedAt), asc(boards.name))
      .limit(200);
    return rows.map((row) => ({ ...toBoard(row.board), role: row.role, taskCount: row.taskCount, memberCount: row.memberCount }));
  }

  async getBoard(userId: string, boardId: string): Promise<Board & { role: BoardRole }> {
    const [row] = await this.db
      .select({ board: boards, role: boardMembers.role })
      .from(boards)
      .innerJoin(boardMembers, and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, userId)))
      .where(eq(boards.id, boardId))
      .limit(1);
    if (!row) throw errors.boardNotFound();
    return { ...toBoard(row.board), role: row.role };
  }

  async createBoard(actor: UserRow, input: CreateBoardInput): Promise<BoardSummary> {
    if (actor.isDemo) {
      const [{ count } = { count: 0 }] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(boards)
        .where(eq(boards.ownerId, actor.id));
      if (count >= LIMITS.demoBoardsPerUser) {
        throw errors.limit(`Demo accounts can create at most ${LIMITS.demoBoardsPerUser} boards.`);
      }
    }

    const board = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(boards)
        .values({ name: input.name, description: input.description, accent: input.accent, ownerId: actor.id, isDemo: actor.isDemo })
        .returning();
      await tx.insert(boardMembers).values({ boardId: created!.id, userId: actor.id, role: 'owner' });
      await tx.insert(columns).values(DEFAULT_COLUMNS.map((name, position) => ({ boardId: created!.id, name, position })));
      return created!;
    });
    this.log.info({ event: 'board.created', boardId: board.id, userId: actor.id }, 'board created');
    return { ...toBoard(board), role: 'owner', taskCount: 0, memberCount: 1 };
  }

  async updateBoard(actor: UserRow, boardId: string, changes: UpdateBoardInput): Promise<Board> {
    const result = await runBoardTransaction(this.db, { boardId, userId: actor.id, minRole: 'owner' }, async (ctx) => {
      const [updated] = await ctx.tx
        .update(boards)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(boards.id, boardId))
        .returning();
      await recordActivity(ctx, { actionType: 'board.updated', payload: { fields: Object.keys(changes), name: updated!.name } });
      return { board: toBoard(updated!), revision: ctx.revision };
    });
    this.publisher.publish({ type: 'board:sync-required', boardId, revision: result.revision, reason: 'board-updated', actorId: actor.id });
    return result.board;
  }

  async deleteBoard(actor: UserRow, boardId: string): Promise<void> {
    await runBoardTransaction(this.db, { boardId, userId: actor.id, minRole: 'owner' }, async (ctx) => {
      // Cascades to members, columns, tasks, activity and the mutation ledger.
      await ctx.tx.delete(boards).where(eq(boards.id, boardId));
    });
    this.log.info({ event: 'board.deleted', boardId, userId: actor.id }, 'board deleted');
    this.publisher.closeBoard(boardId, actor.id);
  }

  /**
   * Authoritative snapshot. Read in one REPEATABLE READ, read-only transaction so the
   * board revision, columns, tasks and members all come from the same point in time.
   */
  async getSnapshot(userId: string, boardId: string): Promise<BoardSnapshot> {
    return this.db.transaction(
      async (tx) => {
        const [board] = await tx.select().from(boards).where(eq(boards.id, boardId)).limit(1);
        if (!board || !(await membershipRole(tx, boardId, userId))) throw errors.boardNotFound();

        // Sequential on purpose: a transaction is one connection, and pg runs one query at a time.
        const columnRows = await tx.select().from(columns).where(eq(columns.boardId, boardId)).orderBy(asc(columns.position));
        const taskRows = await tx
          .select({ task: tasks })
          .from(tasks)
          .innerJoin(columns, eq(columns.id, tasks.columnId))
          .where(eq(tasks.boardId, boardId))
          .orderBy(asc(columns.position), asc(tasks.position));
        const members = await listMembers(tx, boardId);

        return {
          board: toBoard(board),
          columns: columnRows.map(toColumn),
          tasks: taskRows.map((row) => toTask(row.task)),
          members,
          revision: board.revision,
          generatedAt: new Date().toISOString(),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

export async function listMembers(executor: Executor, boardId: string): Promise<BoardMember[]> {
  const rows = await executor
    .select({ member: boardMembers, user: { id: users.id, name: users.name, email: users.email, avatarColor: users.avatarColor } })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(eq(boardMembers.boardId, boardId))
    .orderBy(asc(boardMembers.joinedAt), asc(users.name));
  return rows.map(({ member, user }) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    avatarColor: user.avatarColor,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
  }));
}
