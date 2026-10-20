import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { sessions, users, type UserRow } from '../database/schema.js';

/**
 * Server-side sessions. The browser holds a random 256-bit token in an HTTP-only
 * cookie; the database stores only its SHA-256 hash, so a database leak does not
 * leak usable session credentials.
 */

export const SESSION_COOKIE = 'sb_session';

export interface AuthContext {
  user: UserRow;
  sessionId: string;
  expiresAt: Date;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
  ) {}

  async create(userId: string): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const [row] = await this.db
      .insert(sessions)
      .values({ tokenHash: hashToken(token), userId, expiresAt })
      .returning({ id: sessions.id });
    return { token, sessionId: row!.id, expiresAt };
  }

  /** Resolves a token to its user, renewing the expiry when more than half the TTL has elapsed. */
  async resolve(token: string | undefined): Promise<(AuthContext & { renewed: boolean }) | null> {
    if (!token || token.length > 128) return null;
    const now = new Date();
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!row) return null;

    let expiresAt = row.session.expiresAt;
    let renewed = false;
    if (expiresAt.getTime() - now.getTime() < this.ttlMs / 2) {
      expiresAt = new Date(now.getTime() + this.ttlMs);
      await this.db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.session.id));
      renewed = true;
    }
    return { user: row.user, sessionId: row.session.id, expiresAt, renewed };
  }

  async isActive(sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return Boolean(row);
  }

  async destroy(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async pruneExpired(): Promise<number> {
    const deleted = await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({ id: sessions.id });
    return deleted.length;
  }
}
