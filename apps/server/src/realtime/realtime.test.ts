import { describe, expect, it } from 'vitest';
import { PresenceTracker } from './presence/presenceTracker.js';
import { TokenBucket } from './rateLimiter.js';
import { parseCookies } from './socketServer.js';

const alice = { id: 'u-alice', name: 'Alice', avatarColor: '#6366f1' };
const bob = { id: 'u-bob', name: 'Bob', avatarColor: '#0ea5e9' };

describe('PresenceTracker', () => {
  it('shows a user once regardless of how many tabs they have open', () => {
    const presence = new PresenceTracker();
    presence.join('board-1', alice, 's1');
    presence.join('board-1', alice, 's2');
    presence.join('board-1', bob, 's3');
    expect(presence.list('board-1')).toEqual([
      { ...alice, connections: 2 },
      { ...bob, connections: 1 },
    ]);
  });

  it('keeps a user online until their last connection leaves', () => {
    const presence = new PresenceTracker();
    presence.join('board-1', alice, 's1');
    presence.join('board-1', alice, 's2');
    expect(presence.leave('board-1', alice.id, 's1')).toBe(true);
    expect(presence.list('board-1')).toEqual([{ ...alice, connections: 1 }]);
    presence.leave('board-1', alice.id, 's2');
    expect(presence.list('board-1')).toEqual([]);
    expect(presence.leave('board-1', alice.id, 's2')).toBe(false);
  });

  it('removes a disconnected socket from every board it joined', () => {
    const presence = new PresenceTracker();
    presence.join('board-1', alice, 's1');
    presence.join('board-2', alice, 's1');
    presence.join('board-2', alice, 's9');
    expect(presence.leaveAll(alice.id, 's1').sort()).toEqual(['board-1', 'board-2']);
    expect(presence.list('board-1')).toEqual([]);
    expect(presence.list('board-2')).toEqual([{ ...alice, connections: 1 }]);
  });

  it('isolates boards', () => {
    const presence = new PresenceTracker();
    presence.join('board-1', alice, 's1');
    presence.join('board-2', bob, 's2');
    expect(presence.list('board-1').map((u) => u.id)).toEqual([alice.id]);
    presence.clearBoard('board-1');
    expect(presence.list('board-1')).toEqual([]);
    expect(presence.list('board-2')).toHaveLength(1);
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    now = 500; // +1 token
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    now = 10_000;
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
  });
});

describe('parseCookies', () => {
  it('parses the session cookie from a Cookie header', () => {
    expect(parseCookies('theme=dark; sb_session=abc%2D123; other=1')).toEqual({ theme: 'dark', sb_session: 'abc-123', other: '1' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('sb_session=first; sb_session=second').sb_session).toBe('first');
  });
});
