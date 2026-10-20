import { BOARD_ACCENTS, LIMITS, type Board, type BoardAccent } from '@syncboard/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/form-controls';
import { cn } from '@/lib/utils';
import { ApiError, api } from '@/services/api';
import { useUi } from '@/stores/uiStore';
import { ACCENT_COLORS } from './accents';

export function BoardSettingsDialog({ open, onOpenChange, board, taskCount }: { open: boolean; onOpenChange: (open: boolean) => void; board: Board; taskCount: number }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Content is unmounted while closed, so every opening starts from the current board. */}
      {open && <SettingsForm board={board} taskCount={taskCount} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function SettingsForm({ board, taskCount, onClose }: { board: Board; taskCount: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const forgetBoard = useUi((state) => state.forgetBoard);
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description);
  const [accent, setAccent] = useState<BoardAccent>(board.accent);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () => api.updateBoard(board.id, { name: name.trim(), description: description.trim(), accent }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
      toast.success('Board updated');
      onClose();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not update the board.'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteBoard(board.id),
    onSuccess: () => {
      forgetBoard(board.id);
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
      toast.success(`Deleted “${board.name}”`);
      void navigate('/');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not delete the board.'),
  });

  return (
    <DialogContent>
        <DialogHeader>
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription>Changes are visible to every member immediately.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="settings-name">Name</Label>
            <Input id="settings-name" value={name} maxLength={LIMITS.boardNameMax} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="settings-description">Description</Label>
            <Textarea id="settings-description" rows={3} value={description} maxLength={LIMITS.boardDescriptionMax} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Accent</Label>
            <div className="flex gap-2">
              {BOARD_ACCENTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={value}
                  aria-pressed={accent === value}
                  onClick={() => setAccent(value)}
                  className={cn('flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-popover', accent === value && 'ring-2 ring-foreground/30')}
                  style={{ backgroundColor: ACCENT_COLORS[value] }}
                >
                  {accent === value && <CheckIcon className="size-3.5 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </DialogFooter>

        <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlertIcon className="size-4" /> Delete board
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Permanently deletes this board, its {taskCount} {taskCount === 1 ? 'task' : 'tasks'} and its activity for every member. This cannot be undone.
          </p>
          {confirmDelete ? (
            <div className="mt-3 flex gap-2">
              <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()} data-testid="confirm-delete-board">
                Yes, delete “{board.name}”
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep board
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="mt-3 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              Delete board…
            </Button>
          )}
        </div>
    </DialogContent>
  );
}
