import { ActivityIcon, ChevronDownIcon, PlugIcon, RefreshCwIcon, UnplugIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { clockTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { goOffline, goOnline, useConnection } from '@/services/socket';
import type { BoardSession, BoardSyncPhase } from '@/sync/boardSession';
import type { ControllerState } from '@/sync/controller';

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium text-foreground" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** Developer panel. Every value shown here is read from the live socket and sync engine. */
export function DiagnosticsPanel({ boardId, state, phase, session }: { boardId: string; state: ControllerState | null; phase: BoardSyncPhase; session: BoardSession | null }) {
  const connection = useConnection();
  const [open, setOpen] = useState(true);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const stats = state?.stats;
  const pending = state?.pending.filter((entry) => entry.status !== 'settled') ?? [];

  return (
    <div className="fixed right-4 bottom-4 z-40 w-[300px] rounded-xl border bg-popover/95 font-mono text-[11px] shadow-2xl backdrop-blur" data-testid="diagnostics-panel">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 font-sans text-xs font-semibold">
        <ActivityIcon className="size-3.5 text-primary" /> Collaboration diagnostics
        <ChevronDownIcon className={cn('ml-auto size-3.5 transition', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="border-t px-3 pt-2 pb-3">
          <dl>
            <Row label="socket" testId="diag-socket">
              {connection.status}
            </Row>
            <Row label="socket id">{connection.socketId ?? '—'}</Row>
            <Row label="room">{connection.status === 'connected' && phase !== 'joining' ? `board:${boardId.slice(0, 8)}…` : '—'}</Row>
            <Row label="sync phase" testId="diag-phase">
              {phase}
            </Row>
            <Row label="board revision" testId="diag-revision">
              {state?.view?.revision ?? '—'}
            </Row>
            <Row label="last event">{stats?.lastEvent ? `${stats.lastEvent.type}${stats.lastEvent.revision !== null ? ` #${stats.lastEvent.revision}` : ''}` : '—'}</Row>
            <Row label="last event at">{stats?.lastEvent ? clockTime(stats.lastEvent.at) : '—'}</Row>
            <Row label="last snapshot">{stats?.lastSnapshotAt ? `${clockTime(stats.lastSnapshotAt)} (${relativeTime(stats.lastSnapshotAt)})` : '—'}</Row>
            <Row label="events applied">{stats?.eventsApplied ?? 0}</Row>
            <Row label="duplicates ignored">{stats?.duplicatesIgnored ?? 0}</Row>
            <Row label="gaps detected">{stats?.gapsDetected ?? 0}</Row>
            <Row label="snapshots applied">{stats?.snapshotsApplied ?? 0}</Row>
            <Row label="retries">{stats?.retries ?? 0}</Row>
            <Row label="conflicts" testId="diag-conflicts">
              {stats?.conflicts ?? 0}
            </Row>
            <Row label="pending mutations" testId="diag-pending">
              {pending.length}
            </Row>
          </dl>
          {pending.length > 0 && (
            <ul className="mt-1.5 max-h-24 overflow-y-auto rounded-md bg-muted p-1.5">
              {pending.map((entry) => (
                <li key={entry.mutationId} className="flex justify-between gap-2">
                  <span>
                    {entry.kind} · {entry.mutationId.slice(0, 8)}
                  </span>
                  <span className="text-muted-foreground">
                    {entry.status}
                    {entry.attempt > 1 ? ` ×${entry.attempt}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-1.5 font-sans">
            {connection.status === 'connected' || connection.status === 'reconnecting' ? (
              <Button size="sm" variant="outline" className="flex-1" onClick={goOffline} data-testid="diag-disconnect">
                <UnplugIcon /> Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="flex-1" onClick={goOnline} data-testid="diag-reconnect">
                <PlugIcon /> Reconnect
              </Button>
            )}
            <Button size="sm" variant="outline" className="flex-1" disabled={!session} onClick={() => void session?.refresh()}>
              <RefreshCwIcon /> Resync
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
