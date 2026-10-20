import type { SocketStatus } from '@/services/socket';
import type { BoardSyncPhase } from '@/sync/boardSession';

export type ConnectionKind = 'connected' | 'synchronizing' | 'reconnecting' | 'offline';

export function connectionKind(status: SocketStatus, phase: BoardSyncPhase): ConnectionKind {
  if (status === 'connected') return phase === 'synced' ? 'connected' : 'synchronizing';
  if (status === 'reconnecting' || status === 'connecting') return 'reconnecting';
  return 'offline';
}
