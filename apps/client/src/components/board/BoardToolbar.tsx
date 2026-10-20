import { PRIORITIES, type BoardMember, type Column } from '@syncboard/shared';
import { FilterIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/form-controls';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menus';
import { Badge, Kbd, UserAvatar } from '@/components/ui/misc';
import { PriorityIcon, StatusIcon } from '@/components/task/TaskIcons';
import { PRIORITY_LABEL, statusKindOf } from '@/lib/taskMeta';
import { UNASSIGNED, isFiltering, useFilters, type DueFilter } from '@/lib/filters';
import { cn } from '@/lib/utils';

const DUE_OPTIONS: Array<{ value: DueFilter; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'week', label: 'Due in 7 days' },
  { value: 'none', label: 'No due date' },
];

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {children}
    </label>
  );
}

export function BoardToolbar({ members, columns, labels, visibleCount, totalCount }: { members: BoardMember[]; columns: Column[]; labels: string[]; visibleCount: number; totalCount: number }) {
  const filters = useFilters();
  const searchRef = useRef<HTMLInputElement>(null);
  const active = isFiltering(filters);
  const activeCount = filters.assignees.length + filters.priorities.length + filters.labels.length + filters.columns.length + (filters.due !== 'any' ? 1 : 0);

  // "/" focuses search, like most productivity tools.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === '/' && !target?.closest('input, textarea, [contenteditable="true"]')) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chips = useMemo(() => {
    const result: Array<{ key: string; label: string; remove: () => void }> = [];
    for (const id of filters.assignees) {
      result.push({ key: `a-${id}`, label: id === UNASSIGNED ? 'Unassigned' : (members.find((m) => m.id === id)?.name ?? 'Member'), remove: () => filters.toggle('assignees', id) });
    }
    for (const p of filters.priorities) result.push({ key: `p-${p}`, label: PRIORITY_LABEL[p], remove: () => filters.toggle('priorities', p) });
    for (const l of filters.labels) result.push({ key: `l-${l}`, label: `#${l}`, remove: () => filters.toggle('labels', l) });
    for (const c of filters.columns) result.push({ key: `c-${c}`, label: columns.find((col) => col.id === c)?.name ?? 'Column', remove: () => filters.toggle('columns', c) });
    if (filters.due !== 'any') result.push({ key: 'due', label: DUE_OPTIONS.find((o) => o.value === filters.due)!.label, remove: () => filters.set({ due: 'any' }) });
    return result;
  }, [filters, members, columns]);

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
      <div className="relative w-full sm:w-64">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={filters.search}
          onChange={(event) => filters.set({ search: event.target.value })}
          placeholder="Search tasks"
          aria-label="Search tasks"
          className="h-8 pr-8 pl-8 text-[13px]"
          data-testid="search-input"
        />
        <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn(activeCount > 0 && 'border-primary/40 text-primary')}>
            <FilterIcon /> Filter
            {activeCount > 0 && <Badge variant="default">{activeCount}</Badge>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="grid max-h-[70vh] w-[320px] gap-4 overflow-y-auto">
          <FilterGroup title="Assignee">
            <CheckRow checked={filters.assignees.includes(UNASSIGNED)} onChange={() => filters.toggle('assignees', UNASSIGNED)}>
              <span className="size-5 rounded-full border border-dashed" /> Unassigned
            </CheckRow>
            {members.map((member) => (
              <CheckRow key={member.id} checked={filters.assignees.includes(member.id)} onChange={() => filters.toggle('assignees', member.id)}>
                <UserAvatar name={member.name} color={member.avatarColor} size="xs" /> {member.name}
              </CheckRow>
            ))}
          </FilterGroup>
          <FilterGroup title="Priority">
            <div className="grid grid-cols-2">
              {[...PRIORITIES].reverse().map((priority) => (
                <CheckRow key={priority} checked={filters.priorities.includes(priority)} onChange={() => filters.toggle('priorities', priority)}>
                  <PriorityIcon priority={priority} /> {PRIORITY_LABEL[priority]}
                </CheckRow>
              ))}
            </div>
          </FilterGroup>
          <FilterGroup title="Due date">
            <div className="grid grid-cols-2 gap-1">
              {DUE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => filters.set({ due: option.value })}
                  className={cn('rounded-md border px-2 py-1 text-left text-[13px] transition hover:bg-muted', filters.due === option.value && 'border-primary bg-primary/5 text-primary')}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </FilterGroup>
          <FilterGroup title="Column">
            {columns.map((column) => (
              <CheckRow key={column.id} checked={filters.columns.includes(column.id)} onChange={() => filters.toggle('columns', column.id)}>
                <StatusIcon kind={statusKindOf(column.name)} /> {column.name}
              </CheckRow>
            ))}
          </FilterGroup>
          {labels.length > 0 && (
            <FilterGroup title="Labels">
              <div className="flex flex-wrap gap-1.5">
                {labels.map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => filters.toggle('labels', label)}
                    className={cn('rounded-md border px-2 py-0.5 text-xs transition hover:bg-muted', filters.labels.includes(label) && 'border-primary bg-primary/5 text-primary')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
        </PopoverContent>
      </Popover>

      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex h-7 items-center gap-1 rounded-md border bg-card pr-1 pl-2 text-xs shadow-xs">
          {chip.label}
          <button type="button" onClick={chip.remove} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove filter ${chip.label}`}>
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      {active && (
        <Button variant="ghost" size="sm" onClick={filters.reset} data-testid="clear-filters">
          Clear all
        </Button>
      )}
      <span className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="task-count">
        {active ? `${visibleCount} of ${totalCount} tasks` : `${totalCount} ${totalCount === 1 ? 'task' : 'tasks'}`}
      </span>
    </div>
  );
}
