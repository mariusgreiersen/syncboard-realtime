import type { PresenceUser } from '@syncboard/shared';
import { Tooltip } from '@/components/ui/menus';
import { UserAvatar } from '@/components/ui/misc';

/** Live collaborators on this board. One avatar per person, however many tabs they have open. */
export function PresenceAvatars({ users, currentUserId }: { users: PresenceUser[]; currentUserId: string }) {
  if (users.length === 0) return null;
  const shown = users.slice(0, 4);
  const others = users.length - shown.length;
  const label = users.length === 1 && users[0]!.id === currentUserId ? 'Only you' : `${users.length} ${users.length === 1 ? 'person' : 'people'} viewing`;

  return (
    <div className="flex items-center gap-2" data-testid="presence" aria-label={`${label}: ${users.map((u) => u.name).join(', ')}`}>
      <div className="flex -space-x-1.5">
        {shown.map((user) => (
          <Tooltip
            key={user.id}
            content={
              <span>
                {user.name}
                {user.id === currentUserId ? ' (you)' : ''}
                {user.connections > 1 ? ` · ${user.connections} tabs` : ''}
              </span>
            }
          >
            <span className="relative inline-flex" data-testid="presence-user" data-user-name={user.name}>
              <UserAvatar name={user.name} color={user.avatarColor} size="md" ring />
              <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-card" aria-hidden="true" />
            </span>
          </Tooltip>
        ))}
        {others > 0 && (
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-card">+{others}</span>
        )}
      </div>
      <span className="hidden text-xs text-muted-foreground lg:inline" data-testid="presence-count">
        {label}
      </span>
    </div>
  );
}
