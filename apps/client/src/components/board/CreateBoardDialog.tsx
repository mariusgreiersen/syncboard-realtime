import { zodResolver } from '@hookform/resolvers/zod';
import { BOARD_ACCENTS, createBoardSchema, type BoardAccent } from '@syncboard/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldError, Input, Label, Textarea } from '@/components/ui/form-controls';
import { ApiError, api } from '@/services/api';
import { cn } from '@/lib/utils';
import { ACCENT_COLORS } from './accents';

type FormValues = z.input<typeof createBoardSchema>;

export function CreateBoardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<FormValues, unknown, z.output<typeof createBoardSchema>>({
    resolver: zodResolver(createBoardSchema),
    defaultValues: { name: '', description: '', accent: 'indigo' },
  });
  const accent = useWatch({ control: form.control, name: 'accent' }) as BoardAccent;

  const create = useMutation({
    mutationFn: api.createBoard,
    onSuccess: (board) => {
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
      onOpenChange(false);
      form.reset();
      toast.success(`Created “${board.name}”`);
      void navigate(`/boards/${board.id}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not create the board.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a board</DialogTitle>
          <DialogDescription>Boards start with Backlog, To Do, In Progress and Done columns.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={form.handleSubmit((values) => create.mutate(values))} noValidate>
          <div className="grid gap-2">
            <Label htmlFor="board-name">Name</Label>
            <Input id="board-name" autoFocus placeholder="e.g. Q4 Roadmap" aria-invalid={Boolean(form.formState.errors.name)} {...form.register('name')} />
            <FieldError message={form.formState.errors.name?.message} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-description">Description</Label>
            <Textarea id="board-description" rows={3} placeholder="What is this board for?" {...form.register('description')} />
            <FieldError message={form.formState.errors.description?.message} />
          </div>
          <div className="grid gap-2">
            <Label>Accent</Label>
            <div className="flex gap-2" role="radiogroup" aria-label="Board accent">
              {BOARD_ACCENTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={accent === value}
                  aria-label={value}
                  onClick={() => form.setValue('accent', value)}
                  className={cn('flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-popover transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', accent === value && 'ring-2 ring-foreground/30')}
                  style={{ backgroundColor: ACCENT_COLORS[value] }}
                >
                  {accent === value && <CheckIcon className="size-3.5 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create board'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
