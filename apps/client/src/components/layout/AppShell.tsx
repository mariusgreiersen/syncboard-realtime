import { MenuIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { useMe } from '@/hooks/useAuth';
import { connectSocket, useConnection } from '@/services/socket';
import { useQueryClient } from '@tanstack/react-query';
import { Logo } from './Logo';
import { Sidebar } from './Sidebar';

function FullPageLoader() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true" aria-label="Loading SyncBoard">
      <div className="flex flex-col items-center gap-4">
        <Logo />
        <Skeleton className="h-1.5 w-40" />
      </div>
    </div>
  );
}

/** Authenticated layout: dark sidebar on desktop, slide-over navigation on small screens. */
export function AppShell() {
  const me = useMe();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const unauthorized = useConnection((state) => state.unauthorized);

  useEffect(() => {
    if (me.data) connectSocket();
  }, [me.data]);

  // The socket was rejected as unauthenticated (e.g. the session expired): re-check the session.
  useEffect(() => {
    if (unauthorized) void queryClient.invalidateQueries({ queryKey: ['me'] });
  }, [unauthorized, queryClient]);

  if (me.isPending) return <FullPageLoader />;
  if (me.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium">SyncBoard is unreachable.</p>
        <p className="text-sm text-muted-foreground">The API server did not respond. It may be starting up.</p>
        <Button variant="outline" onClick={() => void me.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <div className="flex h-full">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 shadow-2xl md:hidden" aria-describedby={undefined}>
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <Sidebar onNavigate={() => setMobileNavOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b bg-card px-3 md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>
            <MenuIcon />
          </Button>
          <Logo />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
