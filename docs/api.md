# REST API reference

Base path: `/api/v1`. Bodies are JSON (`content-type: application/json` is required). Authentication
uses the `sb_session` HTTP-only cookie set by register/login/demo. Schemas are the Zod definitions in
[`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts); this page summarises them.
(The reference is hand-written; no OpenAPI file is generated.)

## Errors

Every non-2xx response has the shape:

```json
{ "success": false, "code": "VERSION_CONFLICT", "message": "This task was modified by another collaborator.", "currentVersion": 6, "currentTask": { } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query/params failed validation (`issues: [{ path, message }]`), malformed JSON |
| `UNAUTHORIZED` | 401 | No or invalid session; wrong credentials |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. member editing board settings), origin blocked |
| `BOARD_NOT_FOUND` / `TASK_NOT_FOUND` / `COLUMN_NOT_FOUND` / `USER_NOT_FOUND` / `NOT_FOUND` | 404 | Missing **or not visible to you** |
| `VERSION_CONFLICT` | 409 | Stale `expectedVersion`; includes `currentTask` and `currentVersion` |
| `CONFLICT` | 409 | Duplicate email, already a member, task id taken |
| `LIMIT_EXCEEDED` | 422 | Board/column/member/demo limits |
| `RATE_LIMITED` | 429 | Too many requests |
| `DATABASE_ERROR` | 503 | The change could not be saved |
| `INTERNAL_ERROR` | 500 | Unexpected error (details only in server logs) |

## Auth and profile

| Method & path | Auth | Body | Success |
|---|---|---|---|
| `POST /auth/register` | – | `{ email, password (8–128), name (1–60) }` | 201 `{ user }` + cookie |
| `POST /auth/login` | – | `{ email, password }` | 200 `{ user }` + cookie |
| `POST /auth/demo` | – (only if `DEMO_MODE`) | `{ persona: "alice" \| "bob" \| "charlie" }` | 200 `{ user }` + cookie |
| `POST /auth/logout` | cookie | – | 204, cookie cleared, session's sockets disconnected |
| `GET /auth/me` | ✓ | – | 200 `{ user }` |
| `PATCH /users/me` | ✓ | `{ name?, avatarColor? ("#rrggbb") }` | 200 `{ user }` |
| `GET /config` | – | – | 200 `{ demoMode }` |

Login and registration are limited to 20 requests per minute per IP.

## Boards

| Method & path | Who | Body | Success |
|---|---|---|---|
| `GET /boards` | ✓ | – | `{ boards: BoardSummary[] }` (role, taskCount, memberCount) |
| `POST /boards` | ✓ | `{ name (1–80), description? (≤500), accent? }` | 201 `{ board }` with default columns |
| `GET /boards/:id` | member | – | `{ board }` incl. your `role` |
| `PATCH /boards/:id` | owner | `{ name?, description?, accent? }` | `{ board }`; room gets `board:sync-required` |
| `DELETE /boards/:id` | owner | – | 204; cascades; room gets `board-deleted` |
| `GET /boards/:id/snapshot` | member | – | `BoardSnapshot` (board, ordered columns, ordered tasks, members, `revision`) |
| `GET /boards/:id/activity?limit=30` | member | – | `{ activity: ActivityEvent[] }` (newest first, ≤ 100) |

## Members and columns

| Method & path | Who | Body | Success |
|---|---|---|---|
| `GET /boards/:id/members` | member | – | `{ members }` |
| `POST /boards/:id/members` | owner | `{ email }` of an existing account | 201 `{ member }` |
| `DELETE /boards/:id/members/:userId` | owner, or the member themself | – | 204; their tasks are unassigned; their sockets leave the room |
| `POST /boards/:id/columns` | member | `{ name (1–40) }` | 201 `{ column }` (appended) |
| `PATCH /columns/:id` | member | `{ name }` | `{ column }` |

## Tasks

Mutations return the same object as the Socket.IO acknowledgement:
`{ success: true, mutationId, revision, duplicate, task, event }`. An optional `mutationId` (UUID) makes
the request idempotent: repeating it returns the stored result with `duplicate: true` (HTTP 200).

| Method & path | Body | Success |
|---|---|---|
| `POST /tasks` | `{ boardId, columnId, title, description?, priority?, assigneeId?, dueDate? (YYYY-MM-DD), labels?, index?, taskId?, mutationId? }` | 201 |
| `GET /tasks/:id` | – | `{ task }` |
| `PATCH /tasks/:id` | `{ expectedVersion, changes: { title?, description?, priority?, assigneeId?, dueDate?, labels? }, mutationId? }` | 200, or **409** on a stale version |
| `POST /tasks/:id/move` | `{ expectedVersion, toColumnId, toIndex, mutationId? }` | 200 (`event.orderings` = new order of affected columns), or 409 |
| `DELETE /tasks/:id?expectedVersion=n` | – | 200 (`expectedVersion` optional; 409 if stale) |

`priority` ∈ `low | medium | high | urgent`. `toIndex` counts positions in the target column *excluding*
the moved task and is clamped to the column length.

## Health

| Path | Meaning |
|---|---|
| `GET /health/live` | Process is up |
| `GET /health/ready` | Database reachable (`SELECT 1`); 503 otherwise |

## Example

```bash
# Sign in as the demo owner and keep the cookie
curl -c jar -H 'content-type: application/json' -d '{"persona":"alice"}' http://localhost:8080/api/v1/auth/demo
curl -b jar http://localhost:8080/api/v1/boards/5b0a2d5e-3c1f-4d2a-9a47-7f1c0d9e5a11/snapshot
```
