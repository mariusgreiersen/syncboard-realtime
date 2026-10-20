import { LIMITS, type Column } from '@syncboard/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../database/client.js';
import { columns, type UserRow } from '../../database/schema.js';
import { errors } from '../../lib/errors.js';
import { toColumn } from '../../lib/serialize.js';
import { membershipRole, recordActivity, runBoardTransaction } from '../mutations/boardTransaction.js';
import type { BoardPublisher } from '../mutations/publisher.js';

/** Any board member can add and rename columns. Column changes use the same board lock as task moves. */
export class ColumnService {
  constructor(
    private readonly db: Database,
    private readonly publisher: BoardPublisher,
  ) {}

  async create(actor: UserRow, boardId: string, name: string): Promise<Column> {
    const result = await runBoardTransaction(this.db, { boardId, userId: actor.id }, async (ctx) => {
      const [{ count } = { count: 0 }] = await ctx.tx
        .select({ count: sql<number>`count(*)::int` })
        .from(columns)
        .where(eq(columns.boardId, boardId));
      if (count >= LIMITS.columnsPerBoard) throw errors.limit(`A board can have at most ${LIMITS.columnsPerBoard} columns.`);
      const [row] = await ctx.tx.insert(columns).values({ boardId, name, position: count }).returning();
      await recordActivity(ctx, { actionType: 'column.created', payload: { name } });
      return { column: toColumn(row!), revision: ctx.revision };
    });
    this.publisher.publish({ type: 'board:sync-required', boardId, revision: result.revision, reason: 'columns-changed', actorId: actor.id });
    return result.column;
  }

  async rename(actor: UserRow, columnId: string, name: string): Promise<Column> {
    const [existing] = await this.db.select().from(columns).where(eq(columns.id, columnId)).limit(1);
    if (!existing || !(await membershipRole(this.db, existing.boardId, actor.id))) throw errors.columnNotFound();
    const boardId = existing.boardId;

    const result = await runBoardTransaction(this.db, { boardId, userId: actor.id }, async (ctx) => {
      const [row] = await ctx.tx
        .update(columns)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(columns.id, columnId), eq(columns.boardId, boardId)))
        .returning();
      if (!row) throw errors.columnNotFound();
      await recordActivity(ctx, { actionType: 'column.renamed', payload: { from: existing.name, to: name } });
      return { column: toColumn(row), revision: ctx.revision };
    });
    this.publisher.publish({ type: 'board:sync-required', boardId, revision: result.revision, reason: 'columns-changed', actorId: actor.id });
    return result.column;
  }
}
