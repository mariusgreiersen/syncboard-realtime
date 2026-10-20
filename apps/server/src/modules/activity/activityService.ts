import type { ActivityEvent, ActivityType } from '@syncboard/shared';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../database/client.js';
import { activityEvents, users } from '../../database/schema.js';
import { errors } from '../../lib/errors.js';
import { membershipRole } from '../mutations/boardTransaction.js';

/** Read side of the activity feed. Rows are written by the mutation that they describe, in the same transaction. */
export class ActivityService {
  constructor(private readonly db: Database) {}

  async list(userId: string, boardId: string, limit: number): Promise<ActivityEvent[]> {
    if (!(await membershipRole(this.db, boardId, userId))) throw errors.boardNotFound();
    const rows = await this.db
      .select({ event: activityEvents, actor: { id: users.id, name: users.name, avatarColor: users.avatarColor } })
      .from(activityEvents)
      .leftJoin(users, eq(users.id, activityEvents.actorId))
      .where(eq(activityEvents.boardId, boardId))
      .orderBy(desc(activityEvents.createdAt), desc(activityEvents.revision))
      .limit(limit);
    return rows.map(({ event, actor }) => ({
      id: event.id,
      boardId: event.boardId,
      taskId: event.taskId,
      actor: actor?.id ? { id: actor.id, name: actor.name, avatarColor: actor.avatarColor } : null,
      actionType: event.actionType as ActivityType,
      payload: event.payload,
      revision: event.revision,
      createdAt: event.createdAt.toISOString(),
    }));
  }
}
