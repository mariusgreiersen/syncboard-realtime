import type { BoardSummary } from '@syncboard/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRightIcon, KanbanSquareIcon, LayersIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { accentColor } from '@/components/board/accents';
import { CreateBoardDialog } from '@/components/board/CreateBoardDialog';
import { Button } from '@/components/ui/button';
import { Badge, Skeleton } from '@/components/ui/misc';
import { useCurrentUser } from '@/hooks/useAuth';
import { relativeTime } from '@/lib/format';
import { api } from '@/services/api';

function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function Stat({ icon: Icon, label, value }: { icon: typeof LayersIcon; label: string; value: number | string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-xs">
      <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Icon className="size-4" />
      </span>
      <span>
        <span className="block text-xl font-semibold tabular-nums">{value}</span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function BoardCard({ board }: { board: BoardSummary }) {
  return (
    <Link
      to={`/boards/${board.id}`}
      className="group relative flex flex-col overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accentColor(board.accent) }} />
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold tracking-tight">{board.name}</h3>
        <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
      </div>
      <p className="mt-1.5 line-clamp-2 min-h-10 text-sm text-muted-foreground">{board.description || 'No description'}</p>
      <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <KanbanSquareIcon className="size-3.5" /> {board.taskCount} {board.taskCount === 1 ? 'task' : 'tasks'}
        </span>
        <span className="flex items-center gap-1">
          <UsersIcon className="size-3.5" /> {board.memberCount}
        </span>
        <Badge variant={board.role === 'owner' ? 'default' : 'secondary'} className="ml-auto capitalize">
          {board.role}
        </Badge>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/80">Updated {relativeTime(board.updatedAt)}</p>
    </Link>
  );
}

export function OverviewPage() {
  const user = useCurrentUser();
  const [creating, setCreating] = useState(false);
  const boards = useQuery({ queryKey: ['boards'], queryFn: api.boards });
  const totalTasks = boards.data?.reduce((sum, board) => sum + board.taskCount, 0) ?? 0;
  const owned = boards.data?.filter((board) => board.role === 'owner').length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Workspace overview</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {greeting()}, {user.name.split(' ')[0]}
            </h1>
          </div>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon /> New board
          </Button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Stat icon={LayersIcon} label="Boards you can access" value={boards.data?.length ?? '–'} />
          <Stat icon={KanbanSquareIcon} label="Tasks across your boards" value={boards.data ? totalTasks : '–'} />
          <Stat icon={UsersIcon} label="Boards you own" value={boards.data ? owned : '–'} />
        </div>

        <h2 className="mt-10 mb-4 text-sm font-semibold">My boards</h2>
        {boards.isPending && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        )}
        {boards.isError && <p className="text-sm text-destructive">Could not load boards. {boards.error.message}</p>}
        {boards.data && boards.data.length === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <KanbanSquareIcon className="size-5" />
            </span>
            <h3 className="mt-4 font-semibold">No boards yet</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Create your first board, then add teammates by email to collaborate in real time.</p>
            <Button className="mt-5" onClick={() => setCreating(true)}>
              <PlusIcon /> Create a board
            </Button>
          </div>
        )}
        {boards.data && boards.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.data.map((board) => (
              <BoardCard key={board.id} board={board} />
            ))}
          </div>
        )}
      </div>
      <CreateBoardDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
