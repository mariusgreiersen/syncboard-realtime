/**
 * Pure ordering helpers shared by the server (authoritative reorder inside a
 * transaction) and the client (optimistic preview and filtered drag-and-drop).
 *
 * Task positions are dense integers 0..n-1 within each column.
 */

export function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), length);
}

/** Returns a copy of `ids` with `id` inserted at `index` (clamped). `id` must not already be present. */
export function insertAt(ids: readonly string[], id: string, index: number): string[] {
  const next = ids.filter((existing) => existing !== id);
  next.splice(clampIndex(index, next.length), 0, id);
  return next;
}

export function removeId(ids: readonly string[], id: string): string[] {
  return ids.filter((existing) => existing !== id);
}

export interface ColumnLists {
  [columnId: string]: readonly string[];
}

/**
 * Moves `taskId` to `toIndex` of `toColumnId`. `toIndex` is interpreted against the
 * target column *without* the moved task, which matches what a user sees while dragging.
 * Returns only the columns whose order changed.
 */
export function computeMove(
  lists: ColumnLists,
  taskId: string,
  fromColumnId: string,
  toColumnId: string,
  toIndex: number,
): Record<string, string[]> {
  const source = removeId(lists[fromColumnId] ?? [], taskId);
  if (fromColumnId === toColumnId) {
    return { [toColumnId]: insertAt(source, taskId, toIndex) };
  }
  const target = insertAt(lists[toColumnId] ?? [], taskId, toIndex);
  return { [fromColumnId]: source, [toColumnId]: target };
}

/**
 * Translates a drop index in a *filtered* column (only some cards visible) into an
 * index in the full column, so dragging while a search or filter is active never
 * reorders hidden cards relative to each other.
 *
 * Both lists must already exclude the dragged task. The task is placed directly after
 * the visible card it was dropped below, or directly before the first visible card.
 */
export function visibleIndexToFullIndex(
  fullIds: readonly string[],
  visibleIds: readonly string[],
  visibleIndex: number,
): number {
  if (visibleIds.length === 0) return fullIds.length;
  const index = clampIndex(visibleIndex, visibleIds.length);
  if (index === 0) {
    const first = fullIds.indexOf(visibleIds[0]!);
    return first === -1 ? 0 : first;
  }
  const previous = fullIds.indexOf(visibleIds[index - 1]!);
  return previous === -1 ? fullIds.length : previous + 1;
}

/** Positions that differ between the current and desired order, as (id, position) pairs. */
export function positionChanges(
  current: ReadonlyArray<{ id: string; position: number }>,
  desired: readonly string[],
): Array<{ id: string; position: number }> {
  const currentPositions = new Map(current.map((row) => [row.id, row.position]));
  const changes: Array<{ id: string; position: number }> = [];
  desired.forEach((id, position) => {
    if (currentPositions.get(id) !== position) changes.push({ id, position });
  });
  return changes;
}
