import type { Priority } from '@syncboard/shared';
import type { StatusKind } from '@/lib/taskMeta';
import { cn } from '@/lib/utils';


const PRIORITY_COLOR: Record<Priority, string> = {
  low: 'text-priority-low',
  medium: 'text-priority-medium',
  high: 'text-priority-high',
  urgent: 'text-priority-urgent',
};

/** Signal-bar priority icon (urgent is a filled exclamation square). */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  if (priority === 'urgent') {
    return (
      <svg viewBox="0 0 16 16" className={cn('size-4', PRIORITY_COLOR.urgent, className)} aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <rect x="7.1" y="4" width="1.8" height="5" rx="0.9" fill="white" />
        <circle cx="8" cy="11.3" r="1" fill="white" />
      </svg>
    );
  }
  const level = priority === 'low' ? 1 : priority === 'medium' ? 2 : 3;
  return (
    <svg viewBox="0 0 16 16" className={cn('size-4', PRIORITY_COLOR[priority], className)} aria-hidden="true">
      {[0, 1, 2].map((bar) => (
        <rect key={bar} x={2 + bar * 4.5} y={10 - bar * 3.5} width="3" height={4 + bar * 3.5} rx="1" fill="currentColor" opacity={bar < level ? 1 : 0.22} />
      ))}
    </svg>
  );
}

/** Linear-style status glyph derived from the column name. */
export function StatusIcon({ kind, className }: { kind: StatusKind; className?: string }) {
  const common = cn('size-3.5 shrink-0', className);
  switch (kind) {
    case 'backlog':
      return (
        <svg viewBox="0 0 14 14" className={cn(common, 'text-muted-foreground')} aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.8" />
        </svg>
      );
    case 'todo':
      return (
        <svg viewBox="0 0 14 14" className={cn(common, 'text-muted-foreground')} aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'progress':
      return (
        <svg viewBox="0 0 14 14" className={cn(common, 'text-amber-500')} aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.2 A3.8 3.8 0 0 1 7 10.8 Z" fill="currentColor" />
        </svg>
      );
    case 'done':
      return (
        <svg viewBox="0 0 14 14" className={cn(common, 'text-primary')} aria-hidden="true">
          <circle cx="7" cy="7" r="6.2" fill="currentColor" />
          <path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 14 14" className={cn(common, 'text-sky-500')} aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="7" cy="7" r="2" fill="currentColor" />
        </svg>
      );
  }
}
