import { DEMO_PERSONAS, type DemoPersona } from '@syncboard/shared';
import { and, eq, ne } from 'drizzle-orm';
import { hashPassword } from '../../auth/password.js';
import type { Database, Transaction } from '../../database/client.js';
import { activityEvents, boardMembers, boards, columns, tasks, users, type UserRow } from '../../database/schema.js';
import { errors } from '../../lib/errors.js';
import type { Log } from '../../lib/logger.js';
import { recordActivity, runBoardTransaction } from '../mutations/boardTransaction.js';
import type { BoardPublisher } from '../mutations/publisher.js';
import { DEMO_BOARD, DEMO_BOARD_ID, DEMO_COLUMNS, DEMO_PASSWORD, DEMO_TASKS, DEMO_USERS, isoDateInDays } from './demoData.js';

/**
 * Demo accounts (Alice, Bob, Charlie) and the seeded "Product Launch Workspace".
 * Demo users are flagged `is_demo`; membership rules prevent them from ever sharing a
 * board with a regular account, so a demo session cannot reach private boards.
 */
export class DemoService {
  constructor(
    private readonly db: Database,
    private readonly publisher: BoardPublisher,
    private readonly log: Log,
  ) {}

  async personaUser(persona: DemoPersona): Promise<UserRow> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, DEMO_USERS[persona].email), eq(users.isDemo, true)))
      .limit(1);
    if (!user) throw errors.userNotFound('Demo data has not been seeded. Run `npm run db:seed`.');
    return user;
  }

  /** Idempotent: creates the demo users and board if they do not exist yet. */
  async ensureDemoData(): Promise<{ createdBoard: boolean }> {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    return this.db.transaction(async (tx) => {
      const userIds = await this.ensureUsers(tx, passwordHash);
      const [existing] = await tx.select({ id: boards.id }).from(boards).where(eq(boards.id, DEMO_BOARD_ID)).limit(1);
      if (existing) return { createdBoard: false };

      await tx.insert(boards).values({ id: DEMO_BOARD_ID, ...DEMO_BOARD, ownerId: userIds.alice, isDemo: true });
      await tx.insert(boardMembers).values(demoMemberships(userIds));
      await populateBoard(tx, userIds);
      this.log.info({ event: 'demo.seeded', boardId: DEMO_BOARD_ID }, 'demo board seeded');
      return { createdBoard: true };
    });
  }

  /**
   * Restores the demo board to its seeded content as one board mutation (it takes the
   * board lock and increments the revision, so connected clients resynchronise), and
   * deletes boards that demo users created themselves.
   */
  async resetDemo(): Promise<void> {
    await this.ensureDemoData();
    const alice = await this.personaUser('alice');
    const userIds = await this.ensureUsers(this.db, await hashPassword(DEMO_PASSWORD));

    const revision = await runBoardTransaction(this.db, { boardId: DEMO_BOARD_ID, userId: alice.id }, async (ctx) => {
      await ctx.tx.delete(columns).where(eq(columns.boardId, DEMO_BOARD_ID)); // cascades to tasks
      await ctx.tx.delete(activityEvents).where(eq(activityEvents.boardId, DEMO_BOARD_ID));
      await ctx.tx.update(boards).set({ ...DEMO_BOARD, updatedAt: new Date() }).where(eq(boards.id, DEMO_BOARD_ID));
      await populateBoard(ctx.tx, userIds);
      await recordActivity(ctx, { actionType: 'board.reset', payload: {} });
      return ctx.revision;
    });
    this.publisher.publish({ type: 'board:sync-required', boardId: DEMO_BOARD_ID, revision, reason: 'board-reset', actorId: null });

    const extraBoards = await this.db
      .delete(boards)
      .where(and(eq(boards.isDemo, true), ne(boards.id, DEMO_BOARD_ID)))
      .returning({ id: boards.id });
    for (const board of extraBoards) this.publisher.closeBoard(board.id, alice.id);
    this.log.info({ event: 'demo.reset', boardId: DEMO_BOARD_ID, revision, removedBoards: extraBoards.length }, 'demo data reset');
  }

  private async ensureUsers(executor: Database | Transaction, passwordHash: string): Promise<Record<DemoPersona, string>> {
    const ids = {} as Record<DemoPersona, string>;
    for (const persona of DEMO_PERSONAS) {
      const profile = DEMO_USERS[persona];
      const [row] = await executor
        .insert(users)
        .values({ ...profile, passwordHash, isDemo: true })
        .onConflictDoUpdate({ target: users.email, set: { name: profile.name, avatarColor: profile.avatarColor, isDemo: true } })
        .returning({ id: users.id });
      ids[persona] = row!.id;
    }
    const [board] = await executor.select({ id: boards.id }).from(boards).where(eq(boards.id, DEMO_BOARD_ID)).limit(1);
    if (board) {
      // Re-add personas that were removed from the demo board.
      await executor.insert(boardMembers).values(demoMemberships(ids)).onConflictDoNothing();
    }
    return ids;
  }
}

function demoMemberships(ids: Record<DemoPersona, string>) {
  return DEMO_PERSONAS.map((persona) => ({
    boardId: DEMO_BOARD_ID,
    userId: ids[persona],
    role: persona === 'alice' ? ('owner' as const) : ('member' as const),
  }));
}

async function populateBoard(tx: Transaction, userIds: Record<DemoPersona, string>): Promise<void> {
  const columnRows = await tx
    .insert(columns)
    .values(DEMO_COLUMNS.map((name, position) => ({ boardId: DEMO_BOARD_ID, name, position })))
    .returning({ id: columns.id, name: columns.name });
  const columnIdByName = new Map(columnRows.map((row) => [row.name, row.id]));
  const nextPosition = new Map<string, number>();

  await tx.insert(tasks).values(
    DEMO_TASKS.map((task) => {
      const columnId = columnIdByName.get(task.column)!;
      const position = nextPosition.get(columnId) ?? 0;
      nextPosition.set(columnId, position + 1);
      return {
        boardId: DEMO_BOARD_ID,
        columnId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        assigneeId: task.assignee ? userIds[task.assignee] : null,
        dueDate: task.dueInDays === null ? null : isoDateInDays(task.dueInDays),
        labels: task.labels,
        position,
        createdById: userIds.alice,
      };
    }),
  );
}
