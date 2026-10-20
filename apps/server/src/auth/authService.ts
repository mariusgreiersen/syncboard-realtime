import { createHash } from 'node:crypto';
import { AVATAR_COLORS, type User } from '@syncboard/shared';
import type { z } from 'zod';
import type { loginSchema, registerSchema, updateProfileSchema } from '@syncboard/shared';
import { eq } from 'drizzle-orm';
import { PG_ERRORS, pgErrorCode, type Database } from '../database/client.js';
import { users, type UserRow } from '../database/schema.js';
import { AppError, errors } from '../lib/errors.js';
import { toUser } from '../lib/serialize.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';

/** Addresses under this domain are reserved for the seeded demo accounts. */
export const DEMO_EMAIL_DOMAIN = '@syncboard.test';

export function avatarColorFor(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  return AVATAR_COLORS[digest[0]! % AVATAR_COLORS.length]!;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly options: { demoMode: boolean },
  ) {}

  async register(input: z.output<typeof registerSchema>): Promise<UserRow> {
    if (input.email.endsWith(DEMO_EMAIL_DOMAIN)) {
      throw new AppError('VALIDATION_ERROR', 'This email domain is reserved for demo accounts.', {
        issues: [{ path: 'email', message: 'Reserved domain' }],
      });
    }
    try {
      const [user] = await this.db
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password), avatarColor: avatarColorFor(input.email) })
        .returning();
      return user!;
    } catch (error) {
      if (pgErrorCode(error) === PG_ERRORS.uniqueViolation) throw errors.conflict('An account with this email already exists.');
      throw error;
    }
  }

  async login(input: z.output<typeof loginSchema>): Promise<UserRow> {
    const [user] = await this.db.select().from(users).where(eq(users.email, input.email)).limit(1);
    const valid = user ? await verifyPassword(input.password, user.passwordHash) : await verifyAgainstDummy(input.password);
    if (!user || !valid) throw errors.unauthorized('Invalid email or password.');
    if (user.isDemo && !this.options.demoMode) throw errors.forbidden('Demo accounts are disabled on this server.');
    return user;
  }

  async updateProfile(userId: string, changes: z.output<typeof updateProfileSchema>): Promise<User> {
    const [user] = await this.db
      .update(users)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw errors.unauthorized();
    return toUser(user);
  }
}
