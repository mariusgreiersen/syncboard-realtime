import { useQuery } from '@tanstack/react-query';
import { HistoryIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton, UserAvatar } from '@/components/ui/misc';
import { describeActivity } from '@/lib/activity';
import { relativeTime } from '@/lib/format';
import { api } from '@/services/api';

export function ActivityPanel({ boardId, revision, onClose }: { boardId: string; revision: number; onClose: () => void }) {
  // Refetch whenever the board revision moves; rows are written in the same transaction as the change.
  const activity = useQuery({ queryKey: ['activity', boardId, revision], queryFn: () => api.activity(boardId, 40), placeholderData: (previous) => previous });

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-card" aria-label="Recent activity" data-testid="activity-panel">
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <HistoryIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Activity</h2>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close activity" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <ol className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        {activity.isPending && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-3 h-10" />)}
        {activity.data?.length === 0 && <p className="text-sm text-muted-foreground">No activity yet. Changes made on this board will appear here.</p>}
        {activity.data?.map((event) => (
          <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
            {event.actor ? <UserAvatar name={event.actor.name} color={event.actor.avatarColor} size="sm" /> : <span className="size-6 rounded-full bg-muted" />}
            <div className="min-w-0">
              <p className="text-[13px] leading-snug">{describeActivity(event)}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {relativeTime(event.createdAt)} · rev {event.revision}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
