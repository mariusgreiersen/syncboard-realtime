import { CloudOffIcon, LoaderCircleIcon, RefreshCwIcon, WifiIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/menus';
import { cn } from '@/lib/utils';
import { connectionKind, type ConnectionKind } from '@/lib/connection';
import { useConnection } from '@/services/socket';
import type { BoardSyncPhase } from '@/sync/boardSession';

const DISPLAY: Record<ConnectionKind, { label: string; detail: string; className: string; icon: typeof WifiIcon }> = {
  connected: { label: 'Live', detail: 'Connected. Changes sync instantly.', className: 'text-emerald-600 dark:text-emerald-400', icon: WifiIcon },
  synchronizing: { label: 'Synchronizing…', detail: 'Fetching the latest board state from the server.', className: 'text-primary', icon: RefreshCwIcon },
  reconnecting: { label: 'Reconnecting…', detail: 'Connection lost. Reconnecting to SyncBoard…', className: 'text-amber-600 dark:text-amber-400', icon: LoaderCircleIcon },
  offline: { label: 'Offline', detail: 'Disconnected. Changes are paused until you reconnect.', className: 'text-muted-foreground', icon: CloudOffIcon },
};

export function ConnectionIndicator({ phase }: { phase: BoardSyncPhase }) {
  const status = useConnection((state) => state.status);
  const kind = connectionKind(status, phase);
  const { label, detail, className, icon: Icon } = DISPLAY[kind];
  return (
    <Tooltip content={detail} side="bottom">
      <span
        role="status"
        aria-live="polite"
        data-testid="connection-status"
        data-state={kind}
        className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs font-medium shadow-xs', className)}
      >
        {kind === 'connected' ? (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40 [animation-duration:2.5s]" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
        ) : (
          <Icon className={cn('size-3.5', kind !== 'offline' && 'animate-spin [animation-duration:1.6s]')} />
        )}
        {label}
      </span>
    </Tooltip>
  );
}
