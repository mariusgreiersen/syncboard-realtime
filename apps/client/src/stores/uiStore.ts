import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

interface UiState {
  theme: Theme;
  /** Developer setting: show the collaboration diagnostics panel. */
  diagnostics: boolean;
  activityOpen: boolean;
  recentBoardIds: string[];
  setTheme: (theme: Theme) => void;
  setDiagnostics: (enabled: boolean) => void;
  setActivityOpen: (open: boolean) => void;
  visitBoard: (boardId: string) => void;
  forgetBoard: (boardId: string) => void;
}

/** localStorage access is wrapped: in private mode or with blocked storage the app keeps working with defaults. */
const safeLocalStorage = createJSONStorage(() => ({
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // ignore
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
}));

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      diagnostics: false,
      activityOpen: false,
      recentBoardIds: [],
      setTheme: (theme) => set({ theme }),
      setDiagnostics: (diagnostics) => set({ diagnostics }),
      setActivityOpen: (activityOpen) => set({ activityOpen }),
      visitBoard: (boardId) => set((state) => ({ recentBoardIds: [boardId, ...state.recentBoardIds.filter((id) => id !== boardId)].slice(0, 5) })),
      forgetBoard: (boardId) => set((state) => ({ recentBoardIds: state.recentBoardIds.filter((id) => id !== boardId) })),
    }),
    { name: 'syncboard-ui', storage: safeLocalStorage, partialize: ({ theme, diagnostics, activityOpen, recentBoardIds }) => ({ theme, diagnostics, activityOpen, recentBoardIds }) },
  ),
);

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
