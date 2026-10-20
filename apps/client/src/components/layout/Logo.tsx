import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <rect x="7" y="8" width="7" height="16" rx="2" fill="white" />
      <rect x="18" y="8" width="7" height="10" rx="2" fill="white" opacity="0.7" />
    </svg>
  );
}

export function Logo({ className, tone = 'dark' }: { className?: string; tone?: 'dark' | 'light' }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className={cn('text-[15px] font-semibold tracking-tight', tone === 'light' ? 'text-white' : 'text-foreground')}>SyncBoard</span>
    </span>
  );
}
