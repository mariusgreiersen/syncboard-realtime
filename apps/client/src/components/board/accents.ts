import type { BoardAccent } from '@syncboard/shared';

export const ACCENT_COLORS: Record<BoardAccent, string> = {
  indigo: '#6366f1',
  violet: '#8b5cf6',
  sky: '#0ea5e9',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
};

export const accentColor = (accent: string): string => ACCENT_COLORS[accent as BoardAccent] ?? ACCENT_COLORS.indigo;
