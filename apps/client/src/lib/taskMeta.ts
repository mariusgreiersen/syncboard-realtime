import { LIMITS, type Priority } from '@syncboard/shared';

/** Index meaning "end of the column": within the server's index bounds, and clamped by it. */
export const APPEND_INDEX = LIMITS.tasksPerBoard;

export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

export type StatusKind = 'backlog' | 'todo' | 'progress' | 'done' | 'custom';

export function statusKindOf(columnName: string): StatusKind {
  const name = columnName.trim().toLowerCase();
  if (name.includes('backlog') || name.includes('idea')) return 'backlog';
  if (name === 'to do' || name === 'todo' || name.includes('to-do')) return 'todo';
  if (name.includes('progress') || name.includes('doing') || name.includes('review')) return 'progress';
  if (name.includes('done') || name.includes('complete') || name.includes('shipped')) return 'done';
  return 'custom';
}

/** Deterministic, muted label colours; the `label-chip` class adapts them to light and dark mode. */
const LABEL_HUES = [264, 200, 160, 30, 330, 100, 290, 15];
export function labelStyle(label: string): { '--label-hue': number } {
  let hash = 0;
  for (const char of label.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { '--label-hue': LABEL_HUES[hash % LABEL_HUES.length]! };
}
