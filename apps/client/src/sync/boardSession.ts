import type {
  BoardEvent,
  BoardSnapshot,
  ClientToServerEvents,
  PresenceUser,
  ServerToClientEvents,
  SyncReason,
  TaskMutationEventName,
  TaskMutationResult,
} from '@syncboard/shared';
import type { Socket } from 'socket.io-client';
import { AckTimeoutError, BoardSyncController, type ControllerOptions, type MutationTransport, type SyncNotice } from './controller';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocketTransport(socket: ClientSocket): MutationTransport {
  return {
    isConnected: () => socket.connected,
    async emit(event: TaskMutationEventName, payload: object, timeoutMs: number): Promise<TaskMutationResult> {
      try {
        // The payload has been built by the controller for exactly this event name.
        return await (socket.timeout(timeoutMs).emitWithAck as (e: string, p: object) => Promise<TaskMutationResult>)(event, payload);
      } catch {
        throw new AckTimeoutError();
      }
    },
  };
}

export type AccessLostReason = Extract<SyncReason, 'board-deleted' | 'access-revoked'> | 'not-found';

/** joining: waiting for the first snapshot · synced: live · resyncing: fetching a reconciliation snapshot */
export type BoardSyncPhase = 'joining' | 'synced' | 'resyncing';

export interface BoardSessionOptions extends Omit<ControllerOptions, 'userId'> {
  userId: string;
  fetchSnapshot: (boardId: string) => Promise<BoardSnapshot>;
  notify?: (notice: SyncNotice) => void;
  onPresence?: (users: PresenceUser[]) => void;
  onAccessLost?: (reason: AccessLostReason) => void;
  onPhase?: (phase: BoardSyncPhase) => void;
  joinTimeoutMs?: number;
}

const TASK_EVENTS = ['task:created', 'task:updated', 'task:moved', 'task:deleted'] as const;

/**
 * Connects one board to the shared socket:
 *  - joins the board room on connect and on every reconnect (the server re-checks membership),
 *  - feeds snapshots and revisioned events into the controller,
 *  - fetches an authoritative REST snapshot whenever the controller asks (gap, sync-required,
 *    rejected mutation), deduplicating concurrent requests.
 */
export class BoardSession {
  readonly controller: BoardSyncController;
  private phase: BoardSyncPhase = 'joining';
  private snapshotRequest: Promise<void> | null = null;
  private resnapshotQueued = false;
  private stopped = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly socket: ClientSocket,
    readonly boardId: string,
    private readonly options: BoardSessionOptions,
  ) {
    this.controller = new BoardSyncController(
      boardId,
      createSocketTransport(socket),
      {
        requestSnapshot: () => void this.refresh(),
        notify: (notice) => options.notify?.(notice),
      },
      options,
    );
  }

  getPhase(): BoardSyncPhase {
    return this.phase;
  }

  private setPhase(phase: BoardSyncPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase?.(phase);
  }

  start(): void {
    const on = <E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]) => {
      this.socket.on(event, handler as never);
      this.cleanups.push(() => this.socket.off(event, handler as never));
    };

    on('board:snapshot', (snapshot) => {
      if (snapshot.board.id !== this.boardId) return;
      this.controller.receiveSnapshot(snapshot);
      this.setPhase('synced');
    });
    for (const event of TASK_EVENTS) on(event, ((payload: BoardEvent) => this.controller.receiveEvent(payload)) as never);
    on('board:sync-required', (event) => {
      if (event.boardId !== this.boardId) return;
      if (event.reason === 'board-deleted' || event.reason === 'access-revoked') {
        this.options.onAccessLost?.(event.reason);
        return;
      }
      this.controller.receiveEvent(event);
    });
    on('presence:updated', (payload) => {
      if (payload.boardId === this.boardId) this.options.onPresence?.(payload.users);
    });

    const onConnect = () => void this.join();
    const onDisconnect = () => {
      this.controller.handleDisconnect();
      this.setPhase('joining');
      this.options.onPresence?.([]);
    };
    this.socket.on('connect', onConnect);
    this.socket.on('disconnect', onDisconnect);
    this.cleanups.push(() => this.socket.off('connect', onConnect), () => this.socket.off('disconnect', onDisconnect));

    if (this.socket.connected) void this.join();
  }

  /** (Re)joins the room. The server answers with a fresh `board:snapshot`. */
  private async join(): Promise<void> {
    this.setPhase('joining');
    try {
      const result = await this.socket.timeout(this.options.joinTimeoutMs ?? 8_000).emitWithAck('board:join', { boardId: this.boardId });
      if (this.stopped) return;
      if (!result.success) {
        if (result.code === 'BOARD_NOT_FOUND') this.options.onAccessLost?.('not-found');
        return;
      }
    } catch {
      // Join ack timed out: fall back to a REST snapshot so the board still converges.
      if (!this.stopped && this.socket.connected) await this.refresh();
    }
  }

  /** Fetches an authoritative snapshot over REST. Concurrent requests collapse into one (+1 queued). */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.snapshotRequest) {
      this.resnapshotQueued = true;
      return this.snapshotRequest;
    }
    if (this.phase === 'synced') this.setPhase('resyncing');
    this.snapshotRequest = this.options
      .fetchSnapshot(this.boardId)
      .then((snapshot) => {
        if (this.stopped) return;
        this.controller.receiveSnapshot(snapshot);
        this.setPhase('synced');
      })
      .catch((error: unknown) => {
        if (this.stopped) return;
        if (isNotFound(error)) this.options.onAccessLost?.('not-found');
        else if (this.phase === 'resyncing') this.setPhase('synced');
      })
      .finally(() => {
        this.snapshotRequest = null;
        if (this.resnapshotQueued && !this.stopped) {
          this.resnapshotQueued = false;
          void this.refresh();
        }
      });
    return this.snapshotRequest;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.socket.connected) this.socket.emit('board:leave', { boardId: this.boardId }, () => undefined);
    this.controller.dispose();
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 404;
}
