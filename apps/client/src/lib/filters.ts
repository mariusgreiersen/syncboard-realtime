import type { Priority, Task } from '@syncboard/shared';
import { create } from 'zustand';

export type DueFilter = 'any' | 'overdue' | 'week' | 'none';
export const UNASSIGNED = 'unassigned';

export interface TaskFilters {
  search: string;
  /** User ids, or UNASSIGNED. */
  assignees: string[];
  priorities: Priority[];
  labels: string[];
  columns: string[];
  due: DueFilter;
}

export const EMPTY_FILTERS: TaskFilters = { search: '', assignees: [], priorities: [], labels: [], columns: [], due: 'any' };

export function isFiltering(filters: TaskFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.assignees.length > 0 ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0 ||
    filters.columns.length > 0 ||
    filters.due !== 'any'
  );
}

/** YYYY-MM-DD in the viewer's local time zone. */
export function localIsoDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type DueState = 'overdue' | 'soon' | 'later';

/** Overdue, due within two days, or later — relative to the viewer's local "today". */
export function dueState(dueDate: string, today = localIsoDate()): DueState {
  if (dueDate < today) return 'overdue';
  if (dueDate <= addDays(today, 2)) return 'soon';
  return 'later';
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return localIsoDate(new Date(y, m - 1, d + days));
}

/**
 * Client-side filtering only: it changes what is visible, never the stored order.
 * Filters combine with AND; values inside one filter combine with OR.
 */
export function matchesFilters(task: Task, filters: TaskFilters, today = localIsoDate()): boolean {
  const query = filters.search.trim().toLowerCase();
  if (query && !task.title.toLowerCase().includes(query) && !task.description.toLowerCase().includes(query)) return false;
  if (filters.assignees.length > 0 && !filters.assignees.includes(task.assigneeId ?? UNASSIGNED)) return false;
  if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) return false;
  if (filters.columns.length > 0 && !filters.columns.includes(task.columnId)) return false;
  if (filters.labels.length > 0) {
    const labels = task.labels.map((label) => label.toLowerCase());
    if (!filters.labels.some((label) => labels.includes(label.toLowerCase()))) return false;
  }
  switch (filters.due) {
    case 'overdue':
      return task.dueDate !== null && task.dueDate < today;
    case 'week':
      return task.dueDate !== null && task.dueDate >= today && task.dueDate <= addDays(today, 7);
    case 'none':
      return task.dueDate === null;
    default:
      return true;
  }
}

interface FilterStore extends TaskFilters {
  set: (patch: Partial<TaskFilters>) => void;
  toggle: <K extends 'assignees' | 'priorities' | 'labels' | 'columns'>(key: K, value: TaskFilters[K][number]) => void;
  reset: () => void;
}

export const useFilters = create<FilterStore>((set) => ({
  ...EMPTY_FILTERS,
  set: (patch) => set(patch),
  toggle: (key, value) =>
    set((state) => {
      const current = state[key] as string[];
      return { [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] } as Partial<TaskFilters>;
    }),
  reset: () => set(EMPTY_FILTERS),
}));
