import type { BoardSummary } from '@syncboard/shared';
import { useQuery } from '@tanstack/react-query';
import { ClockIcon, LayoutGridIcon, LogOutIcon, MoonIcon, PlusIcon, SettingsIcon, SunIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { accentColor } from '@/components/board/accents';
import { CreateBoardDialog } from '@/components/board/CreateBoardDialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menus';
import { Skeleton, UserAvatar } from '@/components/ui/misc';
import { useCurrentUser, useLogout } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import { useUi } from '@/stores/uiStore';
import { Logo } from './Logo';

const navItem = ({ isActive }: { isActive: boolean }) =>
  cn(
    'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
    isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
  );

function BoardLink({ board, onNavigate }: { board: BoardSummary; onNavigate?: () => void }) {
  return (
    <NavLink to={`/boards/${board.id}`} className={navItem} onClick={onNavigate}>
      <span className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: accentColor(board.accent) }} />
      <span className="truncate">{board.name}</span>
      <span className="ml-auto text-[11px] text-sidebar-muted tabular-nums">{board.taskCount}</span>
    </NavLink>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const user = useCurrentUser();
  const logout = useLogout();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { theme, setTheme, recentBoardIds } = useUi();
  const boards = useQuery({ queryKey: ['boards'], queryFn: api.boards });

  const byId = new Map((boards.data ?? []).map((board) => [board.id, board]));
  const recent = recentBoardIds.map((id) => byId.get(id)).filter((board): board is BoardSummary => Boolean(board)).slice(0, 3);
  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground" aria-label="Main navigation">
      <div className="flex h-14 items-center px-4">
        <Logo tone="light" />
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 pt-2 pb-4 scrollbar-thin">
        <div className="grid gap-0.5">
          <NavLink to="/" end className={navItem} onClick={onNavigate}>
            <LayoutGridIcon className="size-4 text-sidebar-muted group-hover:text-current" />
            Workspace overview
          </NavLink>
          <NavLink to="/settings" className={navItem} onClick={onNavigate}>
            <SettingsIcon className="size-4 text-sidebar-muted group-hover:text-current" />
            Settings
          </NavLink>
        </div>

        {recent.length > 0 && (
          <div className="grid gap-0.5">
            <p className="flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium tracking-wide text-sidebar-muted uppercase">
              <ClockIcon className="size-3" /> Recent
            </p>
            {recent.map((board) => (
              <BoardLink key={`recent-${board.id}`} board={board} onNavigate={onNavigate} />
            ))}
          </div>
        )}

        <div className="grid gap-0.5">
          <div className="flex items-center justify-between px-2.5 pb-1">
            <p className="text-[11px] font-medium tracking-wide text-sidebar-muted uppercase">My boards</p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded p-0.5 text-sidebar-muted transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label="Create board"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
          {boards.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className="mx-2.5 my-1 h-5 bg-sidebar-accent" />)}
          {boards.data?.map((board) => <BoardLink key={board.id} board={board} onNavigate={onNavigate} />)}
          {boards.data?.length === 0 && <p className="px-2.5 text-xs text-sidebar-muted">No boards yet.</p>}
        </div>

        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mx-1 flex h-8 items-center justify-center gap-2 rounded-md border border-dashed border-sidebar-border text-[13px] font-medium text-sidebar-foreground transition hover:border-sidebar-muted hover:bg-sidebar-accent"
        >
          <PlusIcon className="size-4" /> Create board
        </button>
      </nav>

      <div className="border-t border-sidebar-border p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition hover:bg-sidebar-accent" data-testid="user-menu">
              <UserAvatar name={user.name} color={user.avatarColor} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-sidebar-accent-foreground">{user.name}</span>
                <span className="block truncate text-[11px] text-sidebar-muted">{user.isDemo ? 'Demo account' : user.email}</span>
              </span>
              <ChevronsUpDownIcon className="size-4 text-sidebar-muted" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void navigate('/settings')}>
              <SettingsIcon /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme(isDark ? 'light' : 'dark')}>
              {isDark ? <SunIcon /> : <MoonIcon />} {isDark ? 'Light mode' : 'Dark mode'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                logout.mutate(undefined, {
                  onSettled: () => void navigate('/login'),
                })
              }
            >
              <LogOutIcon /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CreateBoardDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
