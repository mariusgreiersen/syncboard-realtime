import type { User } from '@syncboard/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/services/api';
import { disconnectSocket } from '@/services/socket';

export const meQueryKey = ['me'] as const;

/** The signed-in user, or null. A 401 is a normal "signed out" state, not an error. */
export function useMe() {
  return useQuery<User | null>({
    queryKey: meQueryKey,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });
}

export function useCurrentUser(): User {
  const { data } = useMe();
  if (!data) throw new Error('useCurrentUser used outside an authenticated route');
  return data;
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      disconnectSocket();
      queryClient.clear();
      queryClient.setQueryData(meQueryKey, null);
    },
  });
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });
}
