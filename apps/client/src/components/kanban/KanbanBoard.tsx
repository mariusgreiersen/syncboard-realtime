import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { LIMITS, visibleIndexToFullIndex, type BoardMember } from '@syncboard/shared';
import { PlusIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form-controls';
import { statusKindOf } from '@/lib/taskMeta';
import { isFiltering, matchesFilters, localIsoDate, type TaskFilters } from '@/lib/filters';
import type { BoardState } from '@/sync/engine';
import { KanbanColumn } from './KanbanColumn';
import { TaskCardView, type CardActions } from './TaskCard';

interface KanbanBoardProps {
  view: BoardState;
  filters: TaskFilters;
  pendingTaskIds: Set<string>;
  disabled: boolean;
  actions: CardActions;
  /** `toIndex` is an index in the full (unfiltered) target column, excluding the moved task. */
  onMove: (taskId: string, toColumnId: string, toIndex: number) => void;
  onCreateTask: (columnId: string, title: string) => void;
  onRenameColumn: (columnId: string, name: string) => void;
  onAddColumn: (name: string) => void;
}

interface DragState {
  activeId: string;
  fromColumnId: string;
  /** Visible task ids per column, updated live while the card hovers over other columns. */
  lists: Record<string, string[]>;
}

const COLUMN_PREFIX = 'column:';

function containerOf(id: UniqueIdentifier, lists: Record<string, string[]>): string | undefined {
  const key = String(id);
  if (key.startsWith(COLUMN_PREFIX)) return key.slice(COLUMN_PREFIX.length);
  return Object.keys(lists).find((columnId) => lists[columnId]!.includes(key));
}

function AddColumn({ onAdd, disabled }: { onAdd: (name: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        className="flex h-11 w-[280px] shrink-0 items-center gap-2 rounded-xl border border-dashed px-4 text-[13px] font-medium text-muted-foreground transition hover:border-foreground/20 hover:bg-column hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:w-[300px]"
      >
        <PlusIcon className="size-4" /> Add column
      </button>
    );
  }
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onAdd(trimmed);
    setName('');
    setEditing(false);
  };
  return (
    <div className="w-[280px] shrink-0 rounded-xl bg-column p-3 sm:w-[300px]">
      <Input
        autoFocus
        value={name}
        maxLength={LIMITS.columnNameMax}
        placeholder="Column name"
        aria-label="New column name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') setEditing(false);
        }}
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={!name.trim()}>
          Add column
        </Button>
      </div>
    </div>
  );
}

export function KanbanBoard({ view, filters, pendingTaskIds, disabled, actions, onMove, onCreateTask, onRenameColumn, onAddColumn }: KanbanBoardProps) {
  const filtering = isFiltering(filters);
  const today = localIsoDate();

  // Filtering only changes what is rendered; the confirmed order is never touched.
  const visible = useMemo(() => {
    const lists: Record<string, string[]> = {};
    for (const column of view.columns) {
      const ids = view.columnTaskIds[column.id] ?? [];
      lists[column.id] = filtering ? ids.filter((id) => view.tasks[id] && matchesFilters(view.tasks[id], filters, today)) : ids;
    }
    return lists;
  }, [view.columns, view.columnTaskIds, view.tasks, filters, filtering, today]);

  const membersById = useMemo(() => new Map<string, BoardMember>(view.members.map((member) => [member.id, member])), [view.members]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const lists = drag?.lists ?? visible;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      const fromColumnId = containerOf(active.id, visible);
      if (!fromColumnId) return;
      setDrag({ activeId: String(active.id), fromColumnId, lists: Object.fromEntries(Object.entries(visible).map(([k, v]) => [k, [...v]])) });
    },
    [visible],
  );

  const onDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over) return;
    setDrag((current) => {
      if (!current) return current;
      const from = containerOf(active.id, current.lists);
      const to = containerOf(over.id, current.lists);
      if (!from || !to || from === to) return current;
      const activeId = String(active.id);
      const target = [...current.lists[to]!];
      const overIndex = target.indexOf(String(over.id));
      const translated = active.rect.current.translated;
      const below = translated ? translated.top > over.rect.top + over.rect.height / 2 : false;
      const index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;
      target.splice(index, 0, activeId);
      return { ...current, lists: { ...current.lists, [from]: current.lists[from]!.filter((id) => id !== activeId), [to]: target } };
    });
  }, []);

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const current = drag;
      setDrag(null);
      if (!current || !over) return;
      const activeId = String(active.id);
      const columnId = containerOf(activeId, current.lists);
      if (!columnId || !view.tasks[activeId]) return;

      let list = current.lists[columnId]!;
      const overId = String(over.id);
      if (!overId.startsWith(COLUMN_PREFIX) && overId !== activeId && list.includes(overId)) {
        list = arrayMove(list, list.indexOf(activeId), list.indexOf(overId));
      }
      const visibleIndex = list.indexOf(activeId);
      const fullWithout = (view.columnTaskIds[columnId] ?? []).filter((id) => id !== activeId);
      const visibleWithout = list.filter((id) => id !== activeId);
      const toIndex = visibleIndexToFullIndex(fullWithout, visibleWithout, visibleIndex);

      const originalIndex = (view.columnTaskIds[current.fromColumnId] ?? []).indexOf(activeId);
      if (columnId === current.fromColumnId && toIndex === originalIndex) return; // dropped where it started
      onMove(activeId, columnId, toIndex);
    },
    [drag, onMove, view.columnTaskIds, view.tasks],
  );

  const columnName = useCallback((id: string | undefined) => view.columns.find((c) => c.id === id)?.name ?? 'a column', [view.columns]);
  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active }) => `Picked up ${view.tasks[String(active.id)]?.title ?? 'task'}.`,
      onDragOver: ({ active, over }) => (over ? `${view.tasks[String(active.id)]?.title ?? 'Task'} is over ${columnName(containerOf(over.id, lists))}.` : undefined),
      onDragEnd: ({ active, over }) => (over ? `Dropped ${view.tasks[String(active.id)]?.title ?? 'task'} in ${columnName(containerOf(over.id, lists))}.` : 'Drop cancelled.'),
      onDragCancel: () => 'Drag cancelled. The task was returned to its position.',
    }),
    [columnName, lists, view.tasks],
  );

  const activeTask = drag ? view.tasks[drag.activeId] : undefined;
  const activeColumn = activeTask ? view.columns.find((c) => c.id === activeTask.columnId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDrag(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: 'To pick up a task, press space. Use the arrow keys to move it, space to drop, and escape to cancel. You can also use the task menu to move it.' },
      }}
    >
      <div className="flex h-full items-start gap-3 overflow-x-auto px-4 pt-1 pb-4 scrollbar-thin sm:px-6" data-testid="kanban-board">
        {view.columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            columns={view.columns}
            taskIds={lists[column.id] ?? []}
            tasks={view.tasks}
            totalCount={(view.columnTaskIds[column.id] ?? []).length}
            membersById={membersById}
            pendingTaskIds={pendingTaskIds}
            disabled={disabled}
            filtering={filtering}
            actions={actions}
            onCreateTask={onCreateTask}
            onRenameColumn={onRenameColumn}
          />
        ))}
        <AddColumn onAdd={onAddColumn} disabled={disabled || view.columns.length >= LIMITS.columnsPerBoard} />
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {activeTask ? (
          <TaskCardView
            task={activeTask}
            status={statusKindOf(activeColumn?.name ?? '')}
            assignee={activeTask.assigneeId ? membersById.get(activeTask.assigneeId) : undefined}
            overlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
