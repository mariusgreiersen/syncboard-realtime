# Concurrency control

Two users can edit the same task, drag cards into the same column and retry requests at the same
moment. This document describes the mechanisms that keep PostgreSQL consistent and how they are
tested. Code: [`boardTransaction.ts`](../apps/server/src/modules/mutations/boardTransaction.ts),
[`taskService.ts`](../apps/server/src/modules/tasks/taskService.ts).

## 1. One locking protocol for every board mutation

Every mutation of a board — task create/update/move/delete, column changes, member changes, board
settings, demo reset — runs the same steps in one `READ COMMITTED` transaction:

1. *(task mutations)* `INSERT INTO processed_mutations (id, …) ON CONFLICT DO NOTHING` — idempotency claim
2. `UPDATE boards SET revision = revision + 1 WHERE id = $board RETURNING *` — **row lock** + revision
3. `SELECT role FROM board_members …` — authorisation re-checked *inside* the transaction
4. domain work (conditional updates, renumbering, activity row)
5. `COMMIT`, then publish the event

Consequences:

- Writers of the same board are serialised at step 2; writers of different boards never block each other.
- Every writer acquires the board lock before touching any task row, so there is a single lock order
  and SyncBoard mutations cannot deadlock each other. A bounded retry for `40001`/`40P01` exists
  anyway as a safety net.
- Membership removal also takes the board lock, so "check membership, then write" cannot interleave
  with a concurrent removal.
- Any error rolls back everything, including the revision increment and the activity row.

The trade-off is per-board write throughput: one transaction at a time per board. For a Kanban board
(human-speed edits) this is a good trade for simplicity and determinism.

## 2. Optimistic concurrency control for task content

Each task has an integer `version`. Clients send the version they last saw (`expectedVersion`):

```sql
UPDATE tasks
SET title = $title, …, version = version + 1, updated_at = now()
WHERE id = $id AND board_id = $board AND version = $expectedVersion
RETURNING *;
```

The check and the write are **one atomic statement**. If no row is returned, the service reads the
current row and responds `VERSION_CONFLICT` (HTTP **409**, socket ack `code: "VERSION_CONFLICT"`)
with `currentTask` and `currentVersion`. There is no separate "read version, then update" step.

Moves and deletes are version-checked too, so a move based on a stale view is rejected rather than
silently applied. (This means an edit and a move of the same card by different people conflict even
if they touch different fields; field-level merging is future work.)

In the UI, the task drawer edits against the version it was opened with. If a collaborator commits a
change while you edit, a banner appears immediately; if you save anyway, the conflict panel shows
*theirs* vs *yours* per field and lets you either apply your changes on top of the latest version or
take theirs. Nothing is overwritten without a decision.

## 3. Ordering: dense integer positions

Within a column, task positions are `0 … n-1`.

```sql
ALTER TABLE tasks ADD CONSTRAINT tasks_column_position_key
  UNIQUE (column_id, position) DEFERRABLE INITIALLY DEFERRED;
```

The constraint is **deferred**: it is checked at `COMMIT`, so a transaction can shift and renumber
rows in any order, but no committed state can ever contain two tasks in one slot. A move:

1. locks the board (step 2 above),
2. reads the ordered ids of the source and target columns,
3. computes the new orders with the shared pure function `computeMove()`,
4. updates the moved task conditionally on its version,
5. renumbers only the siblings whose position changed, with one
   `UPDATE … FROM (VALUES …)` statement,
6. returns the authoritative orderings of the affected columns in the event.

`toIndex` is interpreted against the target column *without* the moved task, and clamped. While a
search or filter hides cards, the client translates the drop position with
`visibleIndexToFullIndex()`, so hidden cards keep their relative order.

A composite foreign key `tasks(column_id, board_id) → columns(id, board_id)` guarantees a task's
column belongs to the task's board, even if application code had a bug.

## 4. Idempotent retries

`processed_mutations(id PK, user_id, board_id, kind, result jsonb)` stores the result of each committed
task mutation in the same transaction. A repeated `mutationId` from the same user returns the stored
result (`duplicate: true`); reuse of an id by another user, or for another kind of mutation, is
rejected. Rows older than 24 h are pruned hourly. Rejected mutations roll back their claim, so a retry
of a rejected mutation is evaluated again (and is rejected again if still stale).

## 5. Tests

All of these run against real PostgreSQL with genuinely concurrent HTTP requests
([`tests/integration/concurrency.test.ts`](../tests/integration/concurrency.test.ts),
[`tasks.test.ts`](../tests/integration/tasks.test.ts)):

| Test | Asserts |
|---|---|
| Two competing updates on the same version | exactly one 200 and one 409; DB has the winner's title, version 2 |
| 12 concurrent writers on one version | exactly one success, eleven conflicts |
| Two users move different tasks into one column at once | both succeed; order matches the serialised revision order and the last event's ordering |
| Two users move the same task at once | one success, one conflict; final row is the winner's |
| 20 concurrent creates at index 0 | positions are exactly 0..19 |
| Randomised burst of 60 concurrent moves/edits/creates/deletes | dense unique positions per column; successful revisions are unique and contiguous; one activity row per success |
| Stale move | 409, ordering unchanged |
| Invalid move (column of another board) | 404, task, revision and ledger unchanged (full rollback) |
| Retry racing its original (5 identical requests) | one execution, one task row |
| Snapshot order vs database order | identical |
