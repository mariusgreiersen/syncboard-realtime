import { describe, expect, it } from 'vitest';
import { task } from '@/sync/fixtures';
import { EMPTY_FILTERS, UNASSIGNED, isFiltering, matchesFilters } from './filters';

const today = '2026-10-20';

describe('task filters', () => {
  const t = task('a', 'col-todo', 0, {
    title: 'Implement authentication',
    description: 'Cookies and sessions',
    priority: 'high',
    assigneeId: 'bob',
    labels: ['Backend', 'security'],
    dueDate: '2026-10-22',
  });

  it('matches everything when no filter is active', () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
    expect(matchesFilters(t, EMPTY_FILTERS, today)).toBe(true);
  });

  it('searches titles and descriptions case-insensitively', () => {
    expect(matchesFilters(t, { ...EMPTY_FILTERS, search: 'AUTH' }, today)).toBe(true);
    expect(matchesFilters(t, { ...EMPTY_FILTERS, search: 'sessions' }, today)).toBe(true);
    expect(matchesFilters(t, { ...EMPTY_FILTERS, search: 'payments' }, today)).toBe(false);
  });

  it('combines filters with AND and values with OR', () => {
    expect(matchesFilters(t, { ...EMPTY_FILTERS, priorities: ['low', 'high'], assignees: ['bob'] }, today)).toBe(true);
    expect(matchesFilters(t, { ...EMPTY_FILTERS, priorities: ['high'], assignees: ['alice'] }, today)).toBe(false);
    expect(matchesFilters(task('b', 'c', 0), { ...EMPTY_FILTERS, assignees: [UNASSIGNED] }, today)).toBe(true);
    expect(matchesFilters(t, { ...EMPTY_FILTERS, labels: ['backend'] }, today)).toBe(true);
    expect(matchesFilters(t, { ...EMPTY_FILTERS, columns: ['col-done'] }, today)).toBe(false);
  });

  it('filters by due date', () => {
    expect(matchesFilters(t, { ...EMPTY_FILTERS, due: 'week' }, today)).toBe(true);
    expect(matchesFilters(t, { ...EMPTY_FILTERS, due: 'overdue' }, today)).toBe(false);
    expect(matchesFilters({ ...t, dueDate: '2026-10-19' }, { ...EMPTY_FILTERS, due: 'overdue' }, today)).toBe(true);
    expect(matchesFilters({ ...t, dueDate: null }, { ...EMPTY_FILTERS, due: 'none' }, today)).toBe(true);
    expect(matchesFilters({ ...t, dueDate: '2026-11-30' }, { ...EMPTY_FILTERS, due: 'week' }, today)).toBe(false);
  });
});
