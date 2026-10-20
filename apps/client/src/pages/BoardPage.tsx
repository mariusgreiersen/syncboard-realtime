import { idSchema, type Task } from '@syncboard/shared';
import { useQueryClient } from '@tanstack/react-query';
import { HistoryIcon, MoreHorizontalIcon, SettingsIcon, UserPlusIcon, WifiOffIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityPanel } from '@/components/board/ActivityPanel';
import { accentColor } from '@/components/board/accents';
import { BoardSettingsDialog } from '@/components/board/BoardSettingsDialog';
import { BoardToolbar } from '@/components/board/BoardToolbar';
import { ConnectionIndicator } from '@/components/board/ConnectionIndicator';
import { connectionKind } from '@/lib/connection';
import { DiagnosticsPanel } from '@/components/board/DiagnosticsPanel';
import { MembersDialog } from '@/components/board/MembersDialog';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';
import type { CardActions } from '@/components/kanban/TaskCard';
import { PresenceAvatars } from '@/components/presence/PresenceAvatars';
import { TaskDialog } from '@/components/task/TaskDialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/menus';
import { Skeleton } from '@/components/ui/misc';
import { useCurrentUser } from '@/hooks/useAuth';
import { useBoardSync } from '@/hooks/useBoardSync';
import { isFiltering, localIsoDate, matchesFilters, useFilters } from '@/lib/filters';
import { cn } from '@/lib/utils';
import { ApiError, api } from '@/services/api';
import { useConnection } from '@/services/socket';
import { useUi } from '@/stores/uiStore';

function BoardSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading board">
      <div className="space-y-2 px-4 pt-6 pb-4 sm:px-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-3 px-4 sm:px-6">
        {[5, 4, 3, 2].map((cards, i) => (
          <div key={i} className="w-[280px] shrink-0 space-y-2 rounded-xl bg-column p-3 sm:w-[300px]">
            <Skeleton className="h-4 w-24" />
            {Array.from({ length: cards }, (_, j) => (
              <Skeleton key={j} className="h-20 bg-card" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardUnavailable() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg font-semibold">Board not found</p>
      <p className="max-w-sm text-sm text-muted-foreground">It may have been deleted, or you are not a member of it. Ask the board owner to add you.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to your boards</Link>
      </Button>
    </div>
  );
}

export function BoardPage() {
  const { boardId = '' } = useParams();
  if (!idSchema.safeParse(boardId).success) return <BoardUnavailable />;
  return <BoardView key={boardId} boardId={boardId} />;
}

function BoardView({ boardId }: { boardId: string }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, state, phase, presence, accessLost } = useBoardSync(boardId, user.id);
  const socketStatus = useConnection((s) => s.status);
  const filters = useFilters();
  const resetFilters = useFilters((s) => s.reset);
  const { diagnostics, activityOpen, setActivityOpen, visitBoard } = useUi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openedTask, setOpenedTask] = useState<Task | null>(null);

  const view = state?.view ?? null;
  const controller = session?.controller;
  const kind = connectionKind(socketStatus, phase);
  const offline = kind === 'offline' || kind === 'reconnecting';
  const disabled = socketStatus !== 'connected';

  useEffect(() => {
    resetFilters();
    visitBoard(boardId);
  }, [boardId, resetFilters, visitBoard]);

  useEffect(() => {
    if (!accessLost || accessLost === 'not-found') return;
    toast.error(accessLost === 'board-deleted' ? 'This board was deleted by its owner.' : 'You were removed from this board.');
    void queryClient.invalidateQueries({ queryKey: ['boards'] });
    void navigate('/', { replace: true });
  }, [accessLost, navigate, queryClient]);

  // Keep sidebar task counts roughly current without refetching on every event.
  const revision = view?.revision ?? 0;
  useEffect(() => {
    if (!revision) return;
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['boards'] }), 1_500);
    return () => clearTimeout(timer);
  }, [revision, queryClient]);

  const pendingTaskIds = useMemo(() => new Set((state?.pending ?? []).filter((p) => p.status !== 'settled').map((p) => p.taskId)), [state?.pending]);

  const openTask = useCallback(
    (taskId: string) => {
      setOpenedTask(view?.tasks[taskId] ?? null);
      setSearchParams((params) => {
        params.set('task', taskId);
        return params;
      });
    },
    [setSearchParams, view?.tasks],
  );
  const closeTask = useCallback(() => {
    setOpenedTask(null);
    setSearchParams((params) => {
      params.delete('task');
      return params;
    });
  }, [setSearchParams]);

  const actions: CardActions = useMemo(
    () => ({
      open: openTask,
      moveTo: (taskId, columnId, index) => void controller?.moveTask(taskId, columnId, index),
      moveBy: (taskId, delta) => {
        const task = view?.tasks[taskId];
        if (!task || !view) return;
        const ids = view.columnTaskIds[task.columnId] ?? [];
        const index = ids.indexOf(taskId);
        const next = Math.max(0, Math.min(ids.length - 1, index + delta));
        if (next !== index) void controller?.moveTask(taskId, task.columnId, next);
      },
      remove: (taskId) => void controller?.deleteTask(taskId),
    }),
    [controller, openTask, view],
  );

  const onMove = useCallback((taskId: string, columnId: string, index: number) => void controller?.moveTask(taskId, columnId, index), [controller]);
  const onCreateTask = useCallback((columnId: string, title: string) => void controller?.createTask({ columnId, title }), [controller]);
  const onRenameColumn = useCallback((columnId: string, name: string) => {
    api.renameColumn(columnId, name).catch((error: unknown) => toast.error(error instanceof ApiError ? error.message : 'Could not rename the column.'));
  }, []);
  const onAddColumn = useCallback(
    (name: string) => {
      api.createColumn(boardId, name).catch((error: unknown) => toast.error(error instanceof ApiError ? error.message : 'Could not add the column.'));
    },
    [boardId],
  );

  const labels = useMemo(() => [...new Set(Object.values(view?.tasks ?? {}).flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b)), [view?.tasks]);
  const totalCount = view ? Object.keys(view.tasks).length : 0;
  const visibleCount = useMemo(() => {
    if (!view || !isFiltering(filters)) return totalCount;
    const today = localIsoDate();
    return Object.values(view.tasks).filter((t) => matchesFilters(t, filters, today)).length;
  }, [view, filters, totalCount]);

  if (accessLost === 'not-found') return <BoardUnavailable />;
  if (!view || !controller) return <BoardSkeleton />;

  const me = view.members.find((m) => m.id === user.id);
  const isOwner = me?.role === 'owner';
  const taskParam = searchParams.get('task');
  const selected = taskParam ? view.tasks[taskParam] : undefined;
  // Keep the drawer open (as "deleted") if the task disappears while it is being edited.
  const initialTask = selected ?? (openedTask?.id === taskParam ? openedTask : null);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b bg-card/60 px-4 pt-5 pb-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <nav className="text-xs text-muted-foreground" aria-label="Breadcrumb">
              <Link to="/" className="hover:text-foreground">
                Boards
              </Link>{' '}
              / <span className="text-foreground/80">{view.board.name}</span>
            </nav>
            <h1 className="mt-1 flex items-center gap-2.5 text-xl font-semibold tracking-tight" data-testid="board-title">
              <span className="size-3 shrink-0 rounded" style={{ backgroundColor: accentColor(view.board.accent) }} />
              <span className="truncate">{view.board.name}</span>
            </h1>
            {view.board.description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{view.board.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PresenceAvatars users={presence} currentUserId={user.id} />
            <ConnectionIndicator phase={phase} />
            <Button variant="outline" size="sm" onClick={() => setMembersOpen(true)}>
              <UserPlusIcon /> Share
            </Button>
            <Button variant={activityOpen ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Toggle activity" aria-pressed={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>
              <HistoryIcon />
            </Button>
            {isOwner && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Board actions">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                    <SettingsIcon /> Board settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        {offline && (
          <div role="status" data-testid="offline-banner" className={cn('flex items-center gap-2 border-b px-4 py-2 text-[13px] sm:px-6', kind === 'reconnecting' ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'bg-muted text-muted-foreground')}>
            <WifiOffIcon className="size-4 shrink-0" />
            {kind === 'reconnecting' ? 'Reconnecting to SyncBoard…' : 'You are offline.'} You are seeing the last synchronised board; changes are paused until the connection is back.
          </div>
        )}

        <BoardToolbar members={view.members} columns={view.columns} labels={labels} visibleCount={visibleCount} totalCount={totalCount} />

        <div className="min-h-0 flex-1">
          <KanbanBoard
            view={view}
            filters={filters}
            pendingTaskIds={pendingTaskIds}
            disabled={disabled}
            actions={actions}
            onMove={onMove}
            onCreateTask={onCreateTask}
            onRenameColumn={onRenameColumn}
            onAddColumn={onAddColumn}
          />
        </div>
      </div>

      {activityOpen && (
        <div className="hidden xl:flex">
          <ActivityPanel boardId={boardId} revision={view.revision} onClose={() => setActivityOpen(false)} />
        </div>
      )}

      {taskParam && initialTask && (
        <TaskDialog
          key={taskParam}
          task={selected}
          initialTask={initialTask}
          columns={view.columns}
          members={view.members}
          labelSuggestions={labels}
          controller={controller}
          disabled={disabled}
          onClose={closeTask}
        />
      )}

      <MembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
        boardId={boardId}
        members={view.members}
        currentUserId={user.id}
        isOwner={isOwner}
        isDemo={user.isDemo}
        onChanged={() => void session?.refresh()}
      />
      {isOwner && <BoardSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} board={view.board} taskCount={totalCount} />}
      {diagnostics && <DiagnosticsPanel boardId={boardId} state={state} phase={phase} session={session} />}
    </div>
  );
}
