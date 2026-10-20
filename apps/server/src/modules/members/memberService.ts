import { LIMITS, type BoardMember } from '@syncboard/shared';
import { and, eq, sql } from 'drizzle-orm';
import { PG_ERRORS, pgErrorCode, type Database } from '../../database/client.js';
import { boardMembers, tasks, users, type UserRow } from '../../database/schema.js';
import { errors } from '../../lib/errors.js';
import type { Log } from '../../lib/logger.js';
import { listMembers } from '../boards/boardService.js';
import { membershipRole, recordActivity, runBoardTransaction } from '../mutations/boardTransaction.js';
import type { BoardPublisher } from '../mutations/publisher.js';

export class MemberService {
  constructor(
    private readonly db: Database,
    private readonly publisher: BoardPublisher,
    private readonly log: Log,
  ) {}

  async list(userId: string, boardId: string): Promise<BoardMember[]> {
    if (!(await membershipRole(this.db, boardId, userId))) throw errors.boardNotFound();
    return listMembers(this.db, boardId);
  }

  /** Owner-only. Adds an existing account by email (SyncBoard does not send invitation emails). */
  async add(actor: UserRow, boardId: string, email: string): Promise<BoardMember> {
    const result = await runBoardTransaction(this.db, { boardId, userId: actor.id, minRole: 'owner' }, async (ctx) => {
      const [user] = await ctx.tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user) throw errors.userNotFound('No SyncBoard account uses that email address.');
      // Demo isolation: demo accounts and real accounts never share a board.
      if (user.isDemo !== ctx.board.isDemo) throw errors.forbidden('Demo accounts and regular accounts cannot share boards.');

      const [{ count } = { count: 0 }] = await ctx.tx
        .select({ count: sql<number>`count(*)::int` })
        .from(boardMembers)
        .where(eq(boardMembers.boardId, boardId));
      if (count >= LIMITS.membersPerBoard) throw errors.limit(`A board can have at most ${LIMITS.membersPerBoard} members.`);

      try {
        await ctx.tx.insert(boardMembers).values({ boardId, userId: user.id, role: 'member' });
      } catch (error) {
        if (pgErrorCode(error) === PG_ERRORS.uniqueViolation) throw errors.conflict(`${user.name} is already a member of this board.`);
        throw error;
      }
      await recordActivity(ctx, { actionType: 'member.added', payload: { name: user.name } });
      const member = (await listMembers(ctx.tx, boardId)).find((m) => m.id === user.id)!;
      return { member, revision: ctx.revision };
    });
    this.log.info({ event: 'member.added', boardId, userId: actor.id, memberId: result.member.id }, 'member added');
    this.publisher.publish({ type: 'board:sync-required', boardId, revision: result.revision, reason: 'members-changed', actorId: actor.id });
    return result.member;
  }

  /** Owners can remove any non-owner; members can remove themselves (leave the board). */
  async remove(actor: UserRow, boardId: string, memberId: string): Promise<void> {
    const leaving = actor.id === memberId;
    const revision = await runBoardTransaction(this.db, { boardId, userId: actor.id, minRole: leaving ? 'member' : 'owner' }, async (ctx) => {
      const role = await membershipRole(ctx.tx, boardId, memberId);
      if (!role) throw errors.userNotFound('That user is not a member of this board.');
      if (role === 'owner') throw errors.forbidden('The board owner cannot be removed.');

      // Unassign the member's tasks on this board; each such task changes, so bump its version.
      await ctx.tx
        .update(tasks)
        .set({ assigneeId: null, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(and(eq(tasks.boardId, boardId), eq(tasks.assigneeId, memberId)));
      const [removed] = await ctx.tx
        .delete(boardMembers)
        .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, memberId)))
        .returning({ userId: boardMembers.userId });
      const [user] = await ctx.tx.select({ name: users.name }).from(users).where(eq(users.id, removed!.userId)).limit(1);
      await recordActivity(ctx, { actionType: 'member.removed', payload: { name: user?.name ?? null, left: leaving } });
      return ctx.revision;
    });
    this.log.info({ event: 'member.removed', boardId, userId: actor.id, memberId }, 'member removed');
    // Revoke first so the removed user's sockets do not receive the follow-up notification.
    this.publisher.revokeAccess(boardId, memberId);
    this.publisher.publish({ type: 'board:sync-required', boardId, revision, reason: 'members-changed', actorId: actor.id });
  }
}
