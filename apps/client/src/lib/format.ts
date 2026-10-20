const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string | number, now = Date.now()): string {
  const time = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 10) return 'just now';
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(seconds / 86_400), 'day');
  return new Date(time).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Oct 22" for a YYYY-MM-DD calendar date (no time-zone shifting). */
export function formatDueDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-GB', { hour12: false });
}
