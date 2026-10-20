import type { BoardMember } from '@syncboard/shared';
import { useMutation } from '@tanstack/react-query';
import { UserMinusIcon, UserPlusIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldError, Input, Label } from '@/components/ui/form-controls';
import { Badge, UserAvatar } from '@/components/ui/misc';
import { ApiError, api } from '@/services/api';

interface MembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boardId: string;
  members: BoardMember[];
  currentUserId: string;
  isOwner: boolean;
  isDemo: boolean;
  onChanged: () => void;
}

export function MembersDialog({ open, onOpenChange, boardId, members, currentUserId, isOwner, isDemo, onChanged }: MembersDialogProps) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const add = useMutation({
    mutationFn: (value: string) => api.addMember(boardId, value),
    onSuccess: (member) => {
      toast.success(`${member.name} can now collaborate on this board`);
      setEmail('');
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(boardId, userId),
    onSuccess: (_, userId) => {
      if (userId === currentUserId) {
        toast.success('You left the board');
        void navigate('/');
        return;
      }
      onChanged();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not remove the member.'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim()) add.mutate(email.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share board</DialogTitle>
          <DialogDescription>
            Members can view, create, edit and move tasks. Only the owner manages members and board settings.
          </DialogDescription>
        </DialogHeader>

        {isOwner && (
          <form className="grid gap-2" onSubmit={submit}>
            <Label htmlFor="invite-email">Add an existing SyncBoard account by email</Label>
            <div className="flex gap-2">
              <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" />
              <Button type="submit" disabled={add.isPending || !email.trim()}>
                <UserPlusIcon /> Add
              </Button>
            </div>
            <FieldError message={add.error instanceof ApiError ? add.error.message : add.error ? 'Could not add the member.' : undefined} />
            {isDemo && <p className="text-xs text-muted-foreground">This is a demo board: only demo accounts (Alice, Bob, Charlie) can be members.</p>}
          </form>
        )}

        <ul className="grid gap-1" aria-label="Board members">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60">
              <UserAvatar name={member.name} color={member.avatarColor} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.name} {member.id === currentUserId && <span className="font-normal text-muted-foreground">(you)</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">{member.email}</p>
              </div>
              <Badge variant={member.role === 'owner' ? 'default' : 'secondary'} className="capitalize">
                {member.role}
              </Badge>
              {member.role !== 'owner' && (isOwner || member.id === currentUserId) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={member.id === currentUserId ? 'Leave board' : `Remove ${member.name}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(member.id)}
                >
                  <UserMinusIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
