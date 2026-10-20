import { AVATAR_COLORS } from '@syncboard/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label, Switch } from '@/components/ui/form-controls';
import { UserAvatar } from '@/components/ui/misc';
import { meQueryKey, useCurrentUser, useLogout } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { ApiError, api } from '@/services/api';
import { useUi, type Theme } from '@/stores/uiStore';

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-6 border-b py-8 last:border-0 md:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();
  const { theme, setTheme, diagnostics, setDiagnostics } = useUi();
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.avatarColor);

  const save = useMutation({
    mutationFn: api.updateProfile,
    onSuccess: (updated) => {
      queryClient.setQueryData(meQueryKey, updated);
      toast.success('Profile updated');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save your profile.'),
  });

  const themes: Array<{ value: Theme; label: string; icon: typeof SunIcon }> = [
    { value: 'light', label: 'Light', icon: SunIcon },
    { value: 'dark', label: 'Dark', icon: MoonIcon },
    { value: 'system', label: 'System', icon: MonitorIcon },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

        <Section title="Profile" description="How collaborators see you on boards and in presence indicators.">
          <div className="flex items-center gap-4">
            <UserAvatar name={name || user.name} color={color} size="lg" />
            <div className="text-sm">
              <p className="font-medium">{user.email}</p>
              <p className="text-muted-foreground">{user.isDemo ? 'Demo account — reset with the demo data' : 'Regular account'}</p>
            </div>
          </div>
          <div className="grid max-w-sm gap-2">
            <Label htmlFor="profile-name">Display name</Label>
            <Input id="profile-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Avatar colour</Label>
            <div className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Avatar colour ${value}`}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                  className={cn('flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', color === value && 'ring-2 ring-foreground/30')}
                  style={{ backgroundColor: value }}
                >
                  {color === value && <CheckIcon className="size-3.5 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Button disabled={save.isPending || !name.trim() || (name.trim() === user.name && color === user.avatarColor)} onClick={() => save.mutate({ name: name.trim(), avatarColor: color })}>
              Save profile
            </Button>
          </div>
        </Section>

        <Section title="Appearance" description="Choose a theme. System follows your operating system.">
          <div className="grid max-w-md grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={cn('flex flex-col items-center gap-2 rounded-lg border bg-card p-3 text-sm transition hover:bg-muted', theme === value && 'border-primary ring-2 ring-primary/20')}
              >
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Developer" description="Tools for exploring how SyncBoard synchronises state.">
          <label className="flex max-w-lg items-start justify-between gap-6 rounded-lg border bg-card p-4">
            <span>
              <span className="block text-sm font-medium">Collaboration diagnostics</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                Shows the socket state, board revision, pending mutations, conflicts and controls to simulate a disconnect. Values come from the live sync engine.
              </span>
            </span>
            <Switch checked={diagnostics} onCheckedChange={setDiagnostics} aria-label="Collaboration diagnostics" data-testid="diagnostics-toggle" />
          </label>
        </Section>

        <Section title="Session" description="Signing out ends this session and closes its realtime connection.">
          <div>
            <Button variant="outline" onClick={() => logout.mutate(undefined, { onSettled: () => void navigate('/login') })}>
              Log out
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
