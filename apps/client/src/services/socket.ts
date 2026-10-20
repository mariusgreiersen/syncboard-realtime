import { io } from 'socket.io-client';
import { create } from 'zustand';
import type { ClientSocket } from '@/sync/boardSession';

/*
 * One Socket.IO connection per browser tab, created lazily and shared by every board view.
 * It is a module-level singleton so React re-renders and StrictMode double effects can never
 * open duplicate connections.
 */

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface ConnectionState {
  status: SocketStatus;
  socketId: string | null;
  reconnectAttempt: number;
  lastConnectedAt: number | null;
  lastDisconnectReason: string | null;
  /** True while the user (or the diagnostics panel) deliberately disconnected. */
  manualOffline: boolean;
  unauthorized: boolean;
}

export const useConnection = create<ConnectionState>(() => ({
  status: 'idle',
  socketId: null,
  reconnectAttempt: 0,
  lastConnectedAt: null,
  lastDisconnectReason: null,
  manualOffline: false,
  unauthorized: false,
}));

let socket: ClientSocket | null = null;
let hasConnectedBefore = false;

export function getSocket(): ClientSocket {
  if (socket) return socket;
  const instance: ClientSocket = io(import.meta.env.VITE_SOCKET_URL ?? '/', {
    path: '/socket.io',
    autoConnect: false,
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.4,
    // Lets the server log reconnections distinctly. Identity is NOT sent here; it comes from the cookie.
    auth: (cb) => cb({ reconnect: hasConnectedBefore }),
  });

  instance.on('connect', () => {
    hasConnectedBefore = true;
    useConnection.setState({ status: 'connected', socketId: instance.id ?? null, reconnectAttempt: 0, lastConnectedAt: Date.now(), unauthorized: false });
  });
  instance.on('disconnect', (reason) => {
    // Client- or server-initiated disconnects do not auto-reconnect; transport failures do.
    const willReconnect = reason !== 'io client disconnect' && reason !== 'io server disconnect';
    useConnection.setState({ status: willReconnect ? 'reconnecting' : 'disconnected', socketId: null, lastDisconnectReason: reason });
  });
  instance.on('connect_error', (error) => {
    if (error.message === 'UNAUTHORIZED') {
      useConnection.setState({ status: 'disconnected', unauthorized: true, lastDisconnectReason: 'unauthorized' });
      return;
    }
    useConnection.setState({ status: instance.active ? 'reconnecting' : 'disconnected', lastDisconnectReason: error.message });
  });
  instance.io.on('reconnect_attempt', (attempt) => useConnection.setState({ status: 'reconnecting', reconnectAttempt: attempt }));

  socket = instance;
  return instance;
}

export function connectSocket(): void {
  const instance = getSocket();
  useConnection.setState({ manualOffline: false });
  if (!instance.connected && !instance.active) {
    useConnection.setState({ status: hasConnectedBefore ? 'reconnecting' : 'connecting' });
    instance.connect();
  }
}

/** Used on logout. */
export function disconnectSocket(): void {
  hasConnectedBefore = false;
  socket?.disconnect();
  useConnection.setState({ status: 'idle', socketId: null });
}

/** Diagnostics: close the socket to demonstrate offline behaviour and recovery. */
export function goOffline(): void {
  useConnection.setState({ manualOffline: true });
  socket?.disconnect();
}

export function goOnline(): void {
  connectSocket();
}
