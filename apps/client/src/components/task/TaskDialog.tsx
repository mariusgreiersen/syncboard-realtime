import { zodResolver } from '@hookform/resolvers/zod';
import { PRIORITIES, taskFieldsSchema, type BoardMember, type Column, type Priority, type Task, type TaskChanges } from '@syncboard/shared';
import { CalendarIcon, CircleDotIcon, CircleUserIcon, GitCompareArrowsIcon, Loader2Icon, SignalIcon, TagIcon, Trash2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogDescription, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { FieldError, Input, Textarea } from '@/components/ui/form-controls';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/menus';
import { UserAvatar } from '@/components/ui/misc';
import { relativeTime } from '@/lib/format';
import type { BoardSyncController } from '@/sync/controller';
import { LabelInput } from './LabelInput';
import { PriorityIcon, StatusIcon } from '@/components/task/TaskIcons';
import { APPEND_INDEX, PRIORITY_LABEL, statusKindOf } from '@/lib/taskMeta';

type FormValues = z.input<typeof taskFieldsSchema>;
type FormOutput = z.output<typeof taskFieldsSchema>;
const FIELDS = ['title', 'description', 'priority', 'assigneeId', 'dueDate', 'labels'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, string> = { title: 'Title', description: 'Description', priority: 'Priority', assigneeId: 'Assignee', dueDate: 'Due date', labels: 'Labels' };
const UNASSIGNED = '__unassigned__';

const valuesOf = (task: Task): FormValues => ({
  title: task.title,
  description: task.description,
  priority: task.priority,
  assigneeId: task.assigneeId,
  dueDate: task.dueDate,
  labels: task.labels,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedFields(values: FormOutput, base: FormValues): TaskChanges {
  const changes: Record<string, unknown> = {};
  for (const field of FIELDS) if (!same(values[field], base[field])) changes[field] = values[field];
  return changes as TaskChanges;
}

function Property({ icon: Icon, label, children }: { icon: typeof SignalIcon; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-3">
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </span>
      {children}
    </div>
  );
}

interface TaskDialogProps {
  task: Task | undefined;
  /** The task as it was when the drawer opened (kept to show "deleted" state). */
  initialTask: Task;
  columns: Column[];
  members: BoardMember[];
  labelSuggestions: string[];
  controller: BoardSyncController;
  disabled: boolean;
  onClose: () => void;
}

export function TaskDialog({ task, initialTask, columns, members, labelSuggestions, controller, disabled, onClose }: TaskDialogProps) {
  const live = task ?? initialTask;
  const deleted = !task;
  // The version this editor is based on. Saving sends it as expectedVersion.
  const [baseVersion, setBaseVersion] = useState(initialTask.version);
  const [baseValues, setBaseValues] = useState<FormValues>(() => valuesOf(initialTask));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Task | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues, unknown, FormOutput>({ resolver: zodResolver(taskFieldsSchema), defaultValues: valuesOf(initialTask) });
  const values = useWatch({ control: form.control }) as FormValues;
  const dirty = FIELDS.some((field) => !same(values[field], baseValues[field]));

  const rebase = (next: Task) => {
    setBaseVersion(next.version);
    setBaseValues(valuesOf(next));
    form.reset(valuesOf(next));
    setConflict(null);
  };

  // A collaborator changed the task while it is open. Without local edits, follow along silently.
  const remoteChanged = !deleted && !saving && live.version > baseVersion && !conflict;
  useEffect(() => {
    // Resetting a react-hook-form form to follow an external store is inherently imperative.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (remoteChanged && !dirty) rebase(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteChanged, dirty, live.version]);

  const save = async (output: FormOutput, expectedVersion = baseVersion) => {
    const changes = changedFields(output, baseValues);
    if (Object.keys(changes).length === 0) return;
    setSaving(true);
    setError(null);
    const outcome = await controller.updateTask(live.id, changes, expectedVersion);
    setSaving(false);
    if (outcome.ok && outcome.task) {
      rebase(outcome.task);
      toast.success('Task saved');
    } else if (!outcome.ok && outcome.code === 'VERSION_CONFLICT') {
      setConflict(outcome.currentTask ?? null);
    } else if (!outcome.ok) {
      setError(outcome.message);
    }
  };

  const moveTo = async (columnId: string) => {
    if (columnId === live.columnId) return;
    const outcome = await controller.moveTask(live.id, columnId, APPEND_INDEX);
    // Our own move bumps the version; it is not a conflict with our edits.
    if (outcome.ok && outcome.task && !dirty) rebase(outcome.task);
    else if (outcome.ok && outcome.task) setBaseVersion(outcome.task.version);
  };

  const remove = async () => {
    const outcome = await controller.deleteTask(live.id);
    if (outcome.ok) {
      toast.success('Task deleted');
      onClose();
    }
  };

  const conflictRows = useMemo(() => {
    if (!conflict) return [];
    return FIELDS.filter((field) => !same(values[field], valuesOf(conflict)[field]) && !same(values[field], baseValues[field])).map((field) => ({ field, theirs: valuesOf(conflict)[field], yours: values[field] }));
  }, [conflict, values, baseValues]);

  const display = (field: Field, value: unknown): string => {
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return '—';
    if (field === 'assigneeId') return members.find((m) => m.id === value)?.name ?? 'Former member';
    if (field === 'priority') return PRIORITY_LABEL[value as Priority];
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };

  const column = columns.find((c) => c.id === live.columnId);
  const creator = members.find((m) => m.id === live.createdById);
  const readOnly = disabled || deleted;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SheetContent aria-describedby="task-dialog-description" data-testid="task-dialog">
        <form
          className="flex h-full flex-col"
          noValidate
          onSubmit={form.handleSubmit((output) => void save(output))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void form.handleSubmit((output) => void save(output))();
          }}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <StatusIcon kind={statusKindOf(column?.name ?? '')} />
            <span className="text-[13px] text-muted-foreground">{column?.name ?? 'Task'}</span>
            <span className="ml-1 font-mono text-[11px] text-muted-foreground/70" title="Optimistic-concurrency version">
              v{live.version}
            </span>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close">
                <XIcon />
              </Button>
            </DialogClose>
          </header>

          <div className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
            <DialogTitle className="sr-only">Edit task</DialogTitle>
            <DialogDescription id="task-dialog-description" className="sr-only">
              Edit the task. Changes are saved for everyone when you press Save.
            </DialogDescription>

            {deleted && (
              <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> This task was deleted by a collaborator. Your unsaved edits cannot be applied.
              </div>
            )}

            {remoteChanged && dirty && (
              <div role="status" data-testid="remote-change-banner" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium text-amber-700 dark:text-amber-300">A collaborator updated this task while you were editing.</p>
                <p className="mt-0.5 text-muted-foreground">Saving now will be checked against their version, so nothing is overwritten silently.</p>
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => rebase(live)}>
                  Discard my edits and load theirs
                </Button>
              </div>
            )}

            {conflict && (
              <div role="alert" data-testid="conflict-panel" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <GitCompareArrowsIcon className="size-4" /> This task was modified by another collaborator.
                </p>
                <p className="mt-1 text-muted-foreground">Your save was rejected (you edited version {baseVersion}; the latest is {conflict.version}). Compare and choose:</p>
                {conflictRows.length > 0 && (
                  <table className="mt-2 w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 font-medium">Field</th>
                        <th className="py-1 font-medium">Theirs</th>
                        <th className="py-1 font-medium">Yours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conflictRows.map((row) => (
                        <tr key={row.field} className="border-t border-destructive/15 align-top">
                          <td className="py-1 pr-2 text-muted-foreground">{FIELD_LABEL[row.field]}</td>
                          <td className="py-1 pr-2 break-words">{display(row.field, row.theirs)}</td>
                          <td className="py-1 break-words">{display(row.field, row.yours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" onClick={() => void form.handleSubmit((output) => void save(output, conflict.version))()} disabled={saving} data-testid="conflict-keep-mine">
                    Apply my changes on top
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => rebase(task ?? conflict)} data-testid="conflict-use-theirs">
                    Use their version
                  </Button>
                </div>
              </div>
            )}

            <Input
              {...form.register('title')}
              disabled={readOnly}
              aria-label="Title"
              data-testid="task-title-input"
              className="h-auto border-transparent bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            <FieldError message={form.formState.errors.title?.message} />

            <div className="mt-5 grid gap-3">
              <Property icon={CircleDotIcon} label="Status">
                <Select value={live.columnId} onValueChange={(value) => void moveTo(value)} disabled={readOnly}>
                  <SelectTrigger className="h-8" aria-label="Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <StatusIcon kind={statusKindOf(c.name)} /> {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Property>
              <Property icon={SignalIcon} label="Priority">
                <Controller
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={readOnly}>
                      <SelectTrigger className="h-8" aria-label="Priority" data-testid="task-priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[...PRIORITIES].reverse().map((priority) => (
                          <SelectItem key={priority} value={priority}>
                            <PriorityIcon priority={priority} /> {PRIORITY_LABEL[priority]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Property>
              <Property icon={CircleUserIcon} label="Assignee">
                <Controller
                  control={form.control}
                  name="assigneeId"
                  render={({ field }) => (
                    <Select value={field.value ?? UNASSIGNED} onValueChange={(value) => field.onChange(value === UNASSIGNED ? null : value)} disabled={readOnly}>
                      <SelectTrigger className="h-8" aria-label="Assignee">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNASSIGNED}>
                          <span className="size-5 rounded-full border border-dashed" /> Unassigned
                        </SelectItem>
                        {members.map((member) => (
                          <SelectItem key={member.id} value={member.id}>
                            <UserAvatar name={member.name} color={member.avatarColor} size="xs" /> {member.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Property>
              <Property icon={CalendarIcon} label="Due date">
                <Controller
                  control={form.control}
                  name="dueDate"
                  render={({ field }) => (
                    <Input type="date" className="h-8" aria-label="Due date" disabled={readOnly} value={field.value ?? ''} onChange={(event) => field.onChange(event.target.value || null)} />
                  )}
                />
              </Property>
              <Property icon={TagIcon} label="Labels">
                <Controller
                  control={form.control}
                  name="labels"
                  render={({ field }) => <LabelInput value={field.value} onChange={field.onChange} disabled={readOnly} suggestions={labelSuggestions} />}
                />
              </Property>
              <FieldError message={form.formState.errors.labels?.message ?? form.formState.errors.dueDate?.message} />
            </div>

            <div className="mt-6">
              <label htmlFor="task-description" className="text-[13px] font-medium text-muted-foreground">
                Description
              </label>
              <Textarea
                id="task-description"
                {...form.register('description')}
                disabled={readOnly}
                rows={8}
                placeholder="Add more detail…"
                className="mt-2"
                data-testid="task-description-input"
              />
              <FieldError message={form.formState.errors.description?.message} />
            </div>

            <p className="mt-6 text-xs text-muted-foreground">
              Created {creator ? `by ${creator.name} ` : ''}
              {relativeTime(live.createdAt)} · Updated {relativeTime(live.updatedAt)}
            </p>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
            {confirmDelete ? (
              <>
                <Button type="button" variant="destructive" size="sm" onClick={() => void remove()} data-testid="confirm-delete-task">
                  Delete task
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={readOnly} onClick={() => setConfirmDelete(true)}>
                <Trash2Icon /> Delete
              </Button>
            )}
            {error && <span className="text-xs text-destructive">{error}</span>}
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">{dirty ? 'Unsaved changes' : 'Up to date'}</span>
              <Button type="submit" size="sm" disabled={readOnly || !dirty || saving} data-testid="task-save">
                {saving && <Loader2Icon className="animate-spin" />} Save
              </Button>
            </div>
          </footer>
        </form>
      </SheetContent>
    </Dialog>
  );
}
