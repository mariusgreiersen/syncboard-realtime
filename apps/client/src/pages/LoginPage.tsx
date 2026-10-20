import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, registerSchema, type DemoPersona, type User } from '@syncboard/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, RefreshCwIcon, ShieldCheckIcon, ZapIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { z } from 'zod';
import { Logo, LogoMark } from '@/components/layout/Logo';
import { Button } from '@/components/ui/button';
import { FieldError, Input, Label } from '@/components/ui/form-controls';
import { UserAvatar } from '@/components/ui/misc';
import { meQueryKey, useConfig, useMe } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { ApiError, api } from '@/services/api';

const PERSONAS: Array<{ persona: DemoPersona; name: string; color: string; role: string }> = [
  { persona: 'alice', name: 'Alice Andersen', color: '#6366f1', role: 'Board owner' },
  { persona: 'bob', name: 'Bob Nielsen', color: '#0ea5e9', role: 'Member' },
  { persona: 'charlie', name: 'Charlie Holm', color: '#f59e0b', role: 'Member' },
];

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

function BrandPanel() {
  const features = [
    { icon: ZapIcon, title: 'Live by default', text: 'Every card you create or move appears instantly for your team.' },
    { icon: ShieldCheckIcon, title: 'No silent overwrites', text: 'Concurrent edits are detected with per-task versions.' },
    { icon: RefreshCwIcon, title: 'Recovers on its own', text: 'Drop the connection and SyncBoard resynchronises when you are back.' },
  ];
  return (
    <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
      <Logo tone="light" />
      <div className="relative z-10 max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight text-white">Plan together, in real time.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-sidebar-foreground/80">A collaborative Kanban board backed by PostgreSQL, synchronised over WebSockets.</p>
        <ul className="mt-8 grid gap-5">
          {features.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-white">
                <Icon className="size-4" />
              </span>
              <span>
                <span className="block text-sm font-medium text-white">{title}</span>
                <span className="block text-sm text-sidebar-foreground/75">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="relative z-10 grid grid-cols-3 gap-3 opacity-90" aria-hidden="true">
        {['To Do', 'In Progress', 'Done'].map((name, column) => (
          <div key={name} className="rounded-lg bg-sidebar-accent/70 p-2.5">
            <p className="mb-2 text-[11px] font-medium text-sidebar-muted">{name}</p>
            {Array.from({ length: 3 - column + (column === 1 ? 1 : 0) }, (_, i) => (
              <div key={i} className="mb-1.5 rounded-md bg-white/[0.07] p-2">
                <div className="h-1.5 w-4/5 rounded bg-white/25" />
                <div className="mt-1.5 h-1.5 w-2/5 rounded bg-white/10" />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full bg-primary/25 blur-3xl" />
    </div>
  );
}

export function LoginPage() {
  const me = useMe();
  const config = useConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const onAuthenticated = (user: User) => {
    queryClient.setQueryData(meQueryKey, user);
    void queryClient.invalidateQueries({ queryKey: ['boards'] });
    void navigate(from === '/login' ? '/' : from, { replace: true });
  };

  const demo = useMutation({ mutationFn: api.demo, onSuccess: onAuthenticated });
  const login = useMutation({ mutationFn: (v: z.output<typeof loginSchema>) => api.login(v.email, v.password), onSuccess: onAuthenticated });
  const register = useMutation({ mutationFn: api.register, onSuccess: onAuthenticated });

  const loginForm = useForm<z.input<typeof loginSchema>, unknown, z.output<typeof loginSchema>>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  const registerForm = useForm<z.input<typeof registerSchema>, unknown, z.output<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  if (me.data) return <Navigate to="/" replace />;

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <BrandPanel />
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <LogoMark />
            <span className="font-semibold">SyncBoard</span>
          </div>

          {config.data?.demoMode !== false && (
            <section className="mb-8" aria-labelledby="demo-heading">
              <h2 id="demo-heading" className="text-xl font-semibold tracking-tight">
                Try the live demo
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">Sign in as a demo teammate. Open a second window as someone else to watch changes sync.</p>
              <div className="mt-4 grid gap-2">
                {PERSONAS.map(({ persona, name, color, role }) => (
                  <button
                    key={persona}
                    type="button"
                    data-testid={`demo-${persona}`}
                    disabled={demo.isPending}
                    onClick={() => demo.mutate(persona)}
                    className="group flex items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-xs transition hover:border-primary/40 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-60"
                  >
                    <UserAvatar name={name} color={color} size="md" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">Continue as {name.split(' ')[0]}</span>
                      <span className="block text-xs text-muted-foreground">{role} · Product Launch Workspace</span>
                    </span>
                    <ArrowRightIcon className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                  </button>
                ))}
              </div>
              <FieldError message={errorMessage(demo.error) ?? undefined} />
              <div className="mt-8 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or use your account <span className="h-px flex-1 bg-border" />
              </div>
            </section>
          )}

          <div className="mb-5 grid grid-cols-2 rounded-lg bg-muted p-1 text-sm" role="tablist">
            {(['login', 'register'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn('rounded-md py-1.5 font-medium text-muted-foreground transition', mode === value && 'bg-card text-foreground shadow-xs')}
              >
                {value === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          {mode === 'login' ? (
            <form className="grid gap-4" noValidate onSubmit={loginForm.handleSubmit((values) => login.mutate(values))}>
              <div className="grid gap-2">
                <Label htmlFor="login-email">Email</Label>
                <Input id="login-email" type="email" autoComplete="email" aria-invalid={Boolean(loginForm.formState.errors.email)} {...loginForm.register('email')} />
                <FieldError message={loginForm.formState.errors.email?.message} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="login-password">Password</Label>
                <Input id="login-password" type="password" autoComplete="current-password" aria-invalid={Boolean(loginForm.formState.errors.password)} {...loginForm.register('password')} />
                <FieldError message={loginForm.formState.errors.password?.message} />
              </div>
              <FieldError message={errorMessage(login.error) ?? undefined} />
              <Button type="submit" disabled={login.isPending}>
                {login.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          ) : (
            <form className="grid gap-4" noValidate onSubmit={registerForm.handleSubmit((values) => register.mutate(values))}>
              <div className="grid gap-2">
                <Label htmlFor="register-name">Name</Label>
                <Input id="register-name" autoComplete="name" aria-invalid={Boolean(registerForm.formState.errors.name)} {...registerForm.register('name')} />
                <FieldError message={registerForm.formState.errors.name?.message} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="register-email">Email</Label>
                <Input id="register-email" type="email" autoComplete="email" aria-invalid={Boolean(registerForm.formState.errors.email)} {...registerForm.register('email')} />
                <FieldError message={registerForm.formState.errors.email?.message} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="register-password">Password</Label>
                <Input id="register-password" type="password" autoComplete="new-password" aria-invalid={Boolean(registerForm.formState.errors.password)} {...registerForm.register('password')} />
                <FieldError message={registerForm.formState.errors.password?.message} />
              </div>
              <FieldError message={errorMessage(register.error) ?? undefined} />
              <Button type="submit" disabled={register.isPending}>
                {register.isPending ? 'Creating account…' : 'Create account'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
