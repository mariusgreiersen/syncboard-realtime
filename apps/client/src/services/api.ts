import type {
  ActivityEvent,
  ApiErrorBody,
  Board,
  BoardAccent,
  BoardMember,
  BoardRole,
  BoardSnapshot,
  BoardSummary,
  Column,
  DemoPersona,
  ErrorCode,
  User,
} from '@syncboard/shared';

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly body?: ApiErrorBody,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : null,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach SyncBoard. Check your connection.');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const error = data as ApiErrorBody | null;
    throw new ApiError(response.status, error?.code ?? 'INTERNAL_ERROR', error?.message ?? `Request failed (${response.status})`, error ?? undefined);
  }
  return data as T;
}

export const api = {
  config: () => request<{ demoMode: boolean }>('GET', '/config'),
  me: () => request<{ user: User }>('GET', '/auth/me').then((r) => r.user),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/auth/login', { email, password }).then((r) => r.user),
  register: (input: { email: string; password: string; name: string }) => request<{ user: User }>('POST', '/auth/register', input).then((r) => r.user),
  demo: (persona: DemoPersona) => request<{ user: User }>('POST', '/auth/demo', { persona }).then((r) => r.user),
  logout: () => request<void>('POST', '/auth/logout'),
  updateProfile: (changes: { name?: string; avatarColor?: string }) => request<{ user: User }>('PATCH', '/users/me', changes).then((r) => r.user),

  boards: () => request<{ boards: BoardSummary[] }>('GET', '/boards').then((r) => r.boards),
  createBoard: (input: { name: string; description: string; accent: BoardAccent }) =>
    request<{ board: BoardSummary }>('POST', '/boards', input).then((r) => r.board),
  board: (id: string) => request<{ board: Board & { role: BoardRole } }>('GET', `/boards/${id}`).then((r) => r.board),
  updateBoard: (id: string, changes: Partial<{ name: string; description: string; accent: BoardAccent }>) =>
    request<{ board: Board }>('PATCH', `/boards/${id}`, changes).then((r) => r.board),
  deleteBoard: (id: string) => request<void>('DELETE', `/boards/${id}`),
  snapshot: (id: string) => request<BoardSnapshot>('GET', `/boards/${id}/snapshot`),
  activity: (id: string, limit = 30) => request<{ activity: ActivityEvent[] }>('GET', `/boards/${id}/activity?limit=${limit}`).then((r) => r.activity),

  members: (id: string) => request<{ members: BoardMember[] }>('GET', `/boards/${id}/members`).then((r) => r.members),
  addMember: (id: string, email: string) => request<{ member: BoardMember }>('POST', `/boards/${id}/members`, { email }).then((r) => r.member),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/boards/${id}/members/${userId}`),

  createColumn: (boardId: string, name: string) => request<{ column: Column }>('POST', `/boards/${boardId}/columns`, { name }).then((r) => r.column),
  renameColumn: (columnId: string, name: string) => request<{ column: Column }>('PATCH', `/columns/${columnId}`, { name }).then((r) => r.column),
};
