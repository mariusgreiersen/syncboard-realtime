import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { hashToken } from './sessions.js';
import { avatarColorFor } from './authService.js';
import { AVATAR_COLORS } from '@syncboard/shared';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true);
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('Correct horse battery', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes', async () => {
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).resolves.toBe(false);
  });
});

describe('session tokens and avatars', () => {
  it('hashes tokens deterministically with SHA-256', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('derives a stable avatar colour from the palette', () => {
    expect(avatarColorFor('ada@example.com')).toBe(avatarColorFor('ada@example.com'));
    expect(AVATAR_COLORS).toContain(avatarColorFor('grace@example.com'));
  });
});
