import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { LIMITS, type BoardMember, type Column, type Task } from '@syncboard/shared';
import { MoreHorizontalIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { memo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/form-controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menus';
import { StatusIcon } from '@/components/task/TaskIcons';
import { statusKindOf } from '@/lib/taskMeta';
import { cn } from '@/lib/utils';
import { SortableTaskCard, type CardActions } from './TaskCard';

interface KanbanColumnProps {
  column: Column;
  columns: Column[];
  taskIds: string[];
  tasks: Record<string, Task>;
  totalCount: number;
  membersById: Map<string, BoardMember>;
  pendingTaskIds: Set<string>;
  disabled: boolean;
  filtering: boolean;
  actions: CardActions;
  onCreateTask: (columnId: string, title: string) => void;
  onRenameColumn: (columnId: string, name: string) => void;
}

function AddTaskComposer({ onSubmit, onCancel }: { onSubmit: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setTitle('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) submit(event);
    if (event.key === 'Escape') onCancel();
  };
  return (
    <form onSubmit={submit} className="rounded-lg border bg-card p-2 shadow-sm">
      <Textarea
        autoFocus
        rows={2}
        value={title}
        maxLength={LIMITS.taskTitleMax}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Task title…"
        aria-label="New task title"
        className="min-h-0 resize-none border-0 p-1 shadow-none focus-visible:ring-0"
      />
      <div className="mt-1 flex items-center justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!title.trim()}>
          Add task
        </Button>
      </div>
    </form>
  );
}

export const KanbanColumn = memo(function KanbanColumn({
  column,
  columns,
  taskIds,
  tasks,
  totalCount,
  membersById,
  pendingTaskIds,
  disabled,
  filtering,
  actions,
  onCreateTask,
  onRenameColumn,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}`, data: { type: 'column', columnId: column.id }, disabled });
  const [composing, setComposing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);
  const status = statusKindOf(column.name);

  const finishRename = () => {
    setRenaming(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== column.name) onRenameColumn(column.id, trimmed);
    else setName(column.name);
  };

  return (
    <section
      className="flex max-h-full w-[280px] shrink-0 flex-col rounded-xl bg-column sm:w-[300px]"
      aria-label={`${column.name} column, ${totalCount} tasks`}
      data-testid="kanban-column"
      data-column-name={column.name}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <StatusIcon kind={status} />
        {renaming ? (
          <Input
            autoFocus
            value={name}
            maxLength={LIMITS.columnNameMax}
            onChange={(event) => setName(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishRename();
              if (event.key === 'Escape') {
                setName(column.name);
                setRenaming(false);
              }
            }}
            className="h-7 px-2 text-[13px]"
            aria-label="Column name"
          />
        ) : (
          <h2 className="truncate text-[13px] font-semibold" onDoubleClick={() => !disabled && setRenaming(true)}>
            {column.name}
          </h2>
        )}
        <span className="rounded-full bg-background px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums" data-testid="column-count">
          {filtering ? `${taskIds.length}/${totalCount}` : totalCount}
        </span>
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon-sm" aria-label={`Add task to ${column.name}`} disabled={disabled} onClick={() => setComposing(true)}>
            <PlusIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${column.name} column actions`} disabled={disabled}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setName(column.name);
                  setRenaming(true);
                }}
              >
                <PencilIcon /> Rename column
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setComposing(true)}>
                <PlusIcon /> Add task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 scrollbar-thin">
        <SortableContext id={column.id} items={taskIds} strategy={verticalListSortingStrategy}>
          <ul
            ref={setNodeRef}
            className={cn('flex min-h-16 shrink-0 flex-col gap-2 rounded-lg p-0.5 transition-colors', isOver && 'bg-primary/5 ring-2 ring-primary/25 ring-inset')}
            data-testid="column-tasks"
          >
            {taskIds.map((id) => {
              const task = tasks[id];
              if (!task) return null;
              return (
                <SortableTaskCard
                  key={id}
                  task={task}
                  columnId={column.id}
                  status={status}
                  assignee={task.assigneeId ? membersById.get(task.assigneeId) : undefined}
                  pending={pendingTaskIds.has(id)}
                  columns={columns}
                  actions={actions}
                  disabled={disabled}
                />
              );
            })}
            {taskIds.length === 0 && (
              <li className="flex h-16 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">{filtering && totalCount > 0 ? 'No matching tasks' : 'Drop tasks here'}</li>
            )}
          </ul>
        </SortableContext>
        <div className="mt-2 shrink-0">
          {composing ? (
            <AddTaskComposer
              onSubmit={(title) => onCreateTask(column.id, title)}
              onCancel={() => setComposing(false)}
            />
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setComposing(true)}
              className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <PlusIcon className="size-4" /> Add task
            </button>
          )}
        </div>
      </div>
    </section>
  );
});
