import type { PresenceUser } from '@syncboard/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { connectSocket, getSocket } from '@/services/socket';
import { BoardSession, type AccessLostReason, type BoardSyncPhase } from '@/sync/boardSession';
import type { ControllerState, SyncNotice } from '@/sync/controller';

const noopSubscribe = () => () => undefined;
const nullState = () => null;

function showNotice(notice: SyncNotice): void {
  const id = notice.mutationId ?? notice.code;
  switch (notice.type) {
    case 'conflict':
      toast.warning(notice.message, { id, description: notice.currentTask ? `Latest version: “${notice.currentTask.title}”` : undefined });
      break;
    case 'offline':
      toast.info(notice.message, { id: 'offline' });
      break;
    default:
      toast.error(notice.message, { id });
  }
}

export interface BoardSyncHandle {
  session: BoardSession | null;
  state: ControllerState | null;
  phase: BoardSyncPhase;
  presence: PresenceUser[];
  accessLost: AccessLostReason | null;
}

/**
 * Owns the BoardSession of the open board for the lifetime of the page (callers key the
 * component by board id, so state starts fresh for every board). Listeners are
 * removed on unmount and the room is left, so switching boards never leaks events.
 */
export function useBoardSync(boardId: string, userId: string): BoardSyncHandle {
  const [session, setSession] = useState<BoardSession | null>(null);
  const [phase, setPhase] = useState<BoardSyncPhase>('joining');
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [accessLost, setAccessLost] = useState<AccessLostReason | null>(null);

  useEffect(() => {
    const next = new BoardSession(getSocket(), boardId, {
      userId,
      fetchSnapshot: api.snapshot,
      notify: showNotice,
      onPresence: setPresence,
      onAccessLost: setAccessLost,
      onPhase: setPhase,
    });
    next.start();
    connectSocket();
    // First paint from REST; the socket join delivers its own snapshot moments later.
    void next.refresh();
    // The session is an external resource created per effect run (StrictMode runs effects twice),
    // so it cannot be created during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(next);
    return () => {
      next.stop();
      setPresence([]);
    };
  }, [boardId, userId]);

  const state = useSyncExternalStore(session ? session.controller.subscribe : noopSubscribe, session ? session.controller.getState : nullState);
  return { session, state, phase, presence, accessLost };
}
