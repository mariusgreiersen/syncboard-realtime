import type { PresenceUser, PublicUser } from '@syncboard/shared';

/**
 * Ephemeral, in-memory presence for a single server instance.
 *
 * Presence is keyed by user id, and each user keeps a set of live socket ids per board,
 * so a person with three tabs open appears once (with `connections: 3`) and stays online
 * until their last tab disconnects.
 *
 * Limitation: with more than one server replica this map would only see local sockets;
 * a shared store (e.g. Redis) would be needed. See docs/architecture.md.
 */
export class PresenceTracker {
  private readonly boards = new Map<string, Map<string, { user: PublicUser; sockets: Set<string> }>>();
  private readonly socketBoards = new Map<string, Set<string>>();

  join(boardId: string, user: PublicUser, socketId: string): void {
    let members = this.boards.get(boardId);
    if (!members) {
      members = new Map();
      this.boards.set(boardId, members);
    }
    let entry = members.get(user.id);
    if (!entry) {
      entry = { user, sockets: new Set() };
      members.set(user.id, entry);
    }
    entry.user = user;
    entry.sockets.add(socketId);

    let boardsOfSocket = this.socketBoards.get(socketId);
    if (!boardsOfSocket) {
      boardsOfSocket = new Set();
      this.socketBoards.set(socketId, boardsOfSocket);
    }
    boardsOfSocket.add(boardId);
  }

  /** Returns true if presence of the board changed. */
  leave(boardId: string, userId: string, socketId: string): boolean {
    this.socketBoards.get(socketId)?.delete(boardId);
    const members = this.boards.get(boardId);
    const entry = members?.get(userId);
    if (!members || !entry || !entry.sockets.delete(socketId)) return false;
    if (entry.sockets.size === 0) members.delete(userId);
    if (members.size === 0) this.boards.delete(boardId);
    return true;
  }

  /** Removes a socket from every board it joined; returns the affected board ids. */
  leaveAll(userId: string, socketId: string): string[] {
    const boardIds = [...(this.socketBoards.get(socketId) ?? [])];
    for (const boardId of boardIds) this.leave(boardId, userId, socketId);
    this.socketBoards.delete(socketId);
    return boardIds;
  }

  clearBoard(boardId: string): void {
    const members = this.boards.get(boardId);
    if (!members) return;
    for (const { sockets } of members.values()) {
      for (const socketId of sockets) this.socketBoards.get(socketId)?.delete(boardId);
    }
    this.boards.delete(boardId);
  }

  list(boardId: string): PresenceUser[] {
    const members = this.boards.get(boardId);
    if (!members) return [];
    return [...members.values()]
      .map(({ user, sockets }) => ({ ...user, connections: sockets.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
