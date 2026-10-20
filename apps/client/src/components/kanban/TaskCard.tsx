import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { BoardMember, Column, Task } from '@syncboard/shared';
import { ArrowDownIcon, ArrowRightLeftIcon, ArrowUpIcon, CalendarIcon, CloudUploadIcon, MoreHorizontalIcon, Trash2Icon } from 'lucide-react';
import { memo, type CSSProperties } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/menus';
import { UserAvatar } from '@/components/ui/misc';
import { PriorityIcon, StatusIcon } from '@/components/task/TaskIcons';
import { APPEND_INDEX, PRIORITY_LABEL, labelStyle, statusKindOf, type StatusKind } from '@/lib/taskMeta';
import { dueState } from '@/lib/filters';
import { formatDueDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface CardActions {
  open: (taskId: string) => void;
  moveTo: (taskId: string, columnId: string, index: number) => void;
  moveBy: (taskId: string, delta: -1 | 1) => void;
  remove: (taskId: string) => void;
}

interface TaskCardViewProps {
  task: Task;
  assignee?: BoardMember | undefined;
  status: StatusKind;
  pending?: boolean;
  overlay?: boolean;
  dragging?: boolean;
  columns?: Column[];
  actions?: CardActions;
  disabled?: boolean;
}

function DueChip({ dueDate, done }: { dueDate: string; done: boolean }) {
  const state = done ? 'later' : dueState(dueDate);
  const overdue = state === 'overdue';
  const soon = state === 'soon';
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11px] text-muted-foreground', overdue && 'font-medium text-destructive', soon && 'text-amber-600 dark:text-amber-400')}
      title={overdue ? 'Overdue' : 'Due date'}
    >
      <CalendarIcon className="size-3" />
      {formatDueDate(dueDate)}
    </span>
  );
}

/** Pure presentation of a card (also used for the drag overlay). */
export const TaskCardView = memo(function TaskCardView({ task, assignee, status, pending, overlay, dragging, columns, actions, disabled }: TaskCardViewProps) {
  const visibleLabels = task.labels.slice(0, 3);
  return (
    <div
      className={cn(
        'group/card relative rounded-lg border bg-card p-3 text-left shadow-xs transition-[box-shadow,border-color,opacity]',
        'hover:border-foreground/15 hover:shadow-sm',
        dragging && 'opacity-40',
        overlay && 'rotate-[1.5deg] cursor-grabbing border-primary/40 shadow-xl ring-1 ring-primary/20',
      )}
    >
      <div className="flex items-start gap-2">
        <StatusIcon kind={status} className="mt-0.5" />
        <p className={cn('min-w-0 flex-1 text-[13px] leading-snug font-medium', status === 'done' && 'text-muted-foreground')}>{task.title}</p>
        {actions && columns && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${task.title}`}
                disabled={disabled}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className="-mt-1 -mr-1 rounded p-1 text-muted-foreground opacity-0 transition group-hover/card:opacity-100 hover:bg-muted focus-visible:opacity-100 data-[state=open]:opacity-100 disabled:hidden"
              >
                <MoreHorizontalIcon className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowRightLeftIcon /> Move to
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {columns.map((column) => (
                    <DropdownMenuItem key={column.id} disabled={column.id === task.columnId} onSelect={() => actions.moveTo(task.id, column.id, APPEND_INDEX)}>
                      <StatusIcon kind={statusKindOf(column.name)} /> {column.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={() => actions.moveBy(task.id, -1)}>
                <ArrowUpIcon /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.moveBy(task.id, 1)}>
                <ArrowDownIcon /> Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(task.id)}>
                <Trash2Icon /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {task.description && <p className="mt-1.5 line-clamp-2 pl-[22px] text-xs leading-relaxed text-muted-foreground">{task.description}</p>}

      {visibleLabels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-[22px]">
          {visibleLabels.map((label) => (
            <span key={label} className="label-chip rounded px-1.5 py-px text-[10.5px] font-medium" style={labelStyle(label) as React.CSSProperties}>
              {label}
            </span>
          ))}
          {task.labels.length > 3 && <span className="px-1 text-[10.5px] text-muted-foreground">+{task.labels.length - 3}</span>}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2.5 pl-[22px]">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={`${PRIORITY_LABEL[task.priority]} priority`}>
          <PriorityIcon priority={task.priority} className="size-3.5" />
          <span className="sr-only">{PRIORITY_LABEL[task.priority]} priority</span>
        </span>
        {task.dueDate && <DueChip dueDate={task.dueDate} done={status === 'done'} />}
        <span className="ml-auto flex items-center gap-1.5">
          {pending && (
            <span title="Saving…" aria-label="Saving" data-testid="card-pending">
              <CloudUploadIcon className="size-3.5 animate-pulse text-primary" />
            </span>
          )}
          {assignee && <UserAvatar name={assignee.name} color={assignee.avatarColor} size="xs" />}
        </span>
      </div>
    </div>
  );
});

interface SortableTaskCardProps extends Omit<TaskCardViewProps, 'overlay' | 'dragging'> {
  columnId: string;
}

export const SortableTaskCard = memo(function SortableTaskCard(props: SortableTaskCardProps) {
  const { task, columnId, disabled, actions } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', columnId },
    disabled,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid="task-card"
      data-task-id={task.id}
      data-task-title={task.title}
      aria-roledescription="Draggable task"
      aria-label={`${task.title}. Press space to pick up, or enter to open.`}
      onClick={() => actions?.open(task.id)}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event);
        if (event.key === 'Enter' && !event.defaultPrevented) actions?.open(task.id);
      }}
      className={cn('touch-manipulation rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40', disabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing')}
    >
      <TaskCardView {...props} dragging={isDragging} />
    </li>
  );
});
