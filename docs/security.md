# Security

## Authentication

- **Passwords** are hashed with scrypt (N = 2¹⁵, r = 8, p = 1, 16-byte random salt, 64-byte key) and
  compared in constant time. Login answers an unknown email and a wrong password identically, and
  spends the same hashing work in both cases.
- **Sessions** are server-side. The browser gets a random 256-bit token in an `HttpOnly`,
  `SameSite=Lax` cookie (`Secure` when `COOKIE_SECURE=true`); PostgreSQL stores only its SHA-256 hash.
  Sessions last 7 days and slide when more than half has elapsed. Logout deletes the session row and
  disconnects every socket that was opened with it.
- **Socket.IO**: a connection middleware reads the same cookie from the handshake and resolves the
  session. Unauthenticated handshakes are rejected. The user id is taken from the session — any
  `userId` in an event payload is ignored (a test sends one and checks `created_by_id`). Expired
  sessions are rejected on the next event and the socket is disconnected.

## Authorisation

| Action | Owner | Member | Non-member |
|---|---|---|---|
| View board, snapshot, activity, members | ✓ | ✓ | 404 |
| Create / edit / move / delete tasks | ✓ | ✓ | 404 |
| Add / rename columns | ✓ | ✓ | 404 |
| Edit board settings, delete board | ✓ | 403 | 404 |
| Add / remove members | ✓ | leave only | 404 |

- Non-members get **404 `BOARD_NOT_FOUND`** rather than 403, so board ids cannot be probed.
- **A Socket.IO room is not an authorisation boundary.** Joining requires membership, and every
  mutation re-checks membership inside its transaction (after taking the board lock). A test removes
  Bob while his socket is in the room and verifies his next mutation is rejected and his socket is
  removed from the room (`access-revoked`).
- Tasks can only be assigned to board members; a task's column must belong to its board (also
  enforced by a composite foreign key).

## Demo isolation

Demo personas (Alice, Bob, Charlie) are users with `is_demo = true`; boards they create are demo
boards. Membership is only allowed when `user.is_demo = board.is_demo`, so a demo session can never
be added to — or see — a regular user's board. Registration rejects the reserved demo email domain.
Demo users can own at most 3 boards. `DEMO_MODE=false` disables the one-click sign-in;
`DEMO_RESET_INTERVAL_MINUTES` periodically restores the demo board and deletes demo-created boards.

## CSRF, CORS and origins

- `SameSite=Lax` cookies are not sent on cross-site `POST/PATCH/DELETE`.
- The API accepts only `application/json` bodies (the `text/plain` parser is removed), so HTML forms
  cannot submit to it.
- State-changing requests with an `Origin` header outside `ALLOWED_ORIGINS` (or
  `Sec-Fetch-Site: cross-site`) are rejected with 403.
- WebSocket handshakes are checked against `ALLOWED_ORIGINS` in `allowRequest`, because browsers do
  not apply CORS to WebSockets (cross-site WebSocket hijacking).
- CORS is configured with an explicit origin list and credentials. The recommended deployment is
  same-origin (nginx in front of both), as in Docker Compose.

## Input validation and limits

- Every REST body, query, route parameter and socket payload is validated with Zod schemas from
  `packages/shared`. TypeScript types are not trusted at runtime.
- Limits: title ≤ 200, description ≤ 10 000 characters, ≤ 8 labels of ≤ 24 characters, ≤ 500 tasks and
  ≤ 12 columns per board, ≤ 50 members, JSON body ≤ 64 KB, socket message ≤ 64 KB.
- Rate limits: 20 requests/min per IP on register/login/demo, 600/min per IP overall, and a
  per-socket token bucket (burst 40, 10 mutations/s).

## Transport and headers

- Helmet sets standard security headers on the API. nginx adds a strict CSP (`script-src 'self'`; the
  theme bootstrap script is a static file for that reason), `X-Frame-Options: DENY`, `nosniff`.
- Errors are structured (`{ success: false, code, message }`); stack traces are never returned.
- Pino redacts cookies, authorization headers, `set-cookie`, passwords and tokens. Task contents are
  not logged.

## Known limitations

- No email verification, password reset or MFA.
- Members are added by the email of an existing account; there are no invitation links.
- The per-IP rate limiter is in-memory (single instance).
- `npm audit` (October 2026) reports 4 moderate advisories, all in `drizzle-kit`'s dev-only esbuild
  loader (used only to generate migrations). `npm audit --omit=dev` reports 0.
