import type { BoardEvent } from '@syncboard/shared';

/**
 * Post-commit side effects of board mutations. Services call these only after their
 * transaction has committed. Implemented by the Socket.IO layer; a no-op publisher is
 * used when no realtime server is attached (e.g. scripts).
 *
 * Delivery is best-effort (at most once per connected socket). Correctness never depends
 * on it: clients detect missing revisions and reconcile from an authoritative snapshot.
 */
export interface BoardPublisher {
  publish(event: BoardEvent): void;
  /** Removes a user's sockets from the board room after their membership was removed. */
  revokeAccess(boardId: string, userId: string): void;
  /** Notifies and empties the room of a deleted board. */
  closeBoard(boardId: string, actorId: string): void;
}

export const noopPublisher: BoardPublisher = {
  publish: () => undefined,
  revokeAccess: () => undefined,
  closeBoard: () => undefined,
};

/** Indirection so services can be constructed before the Socket.IO server exists. */
export class PublisherRef implements BoardPublisher {
  private target: BoardPublisher = noopPublisher;

  attach(target: BoardPublisher): void {
    this.target = target;
  }

  publish(event: BoardEvent): void {
    this.target.publish(event);
  }

  revokeAccess(boardId: string, userId: string): void {
    this.target.revokeAccess(boardId, userId);
  }

  closeBoard(boardId: string, actorId: string): void {
    this.target.closeBoard(boardId, actorId);
  }
}
