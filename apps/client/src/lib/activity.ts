import type { ActivityEvent } from '@syncboard/shared';

const quote = (value: unknown) => `“${String(value ?? 'a task')}”`;

/** Human-readable sentence for a stored activity row. */
export function describeActivity(event: ActivityEvent): string {
  const actor = event.actor?.name.split(' ')[0] ?? 'Someone';
  const p = event.payload;
  switch (event.actionType) {
    case 'task.created':
      return `${actor} created ${quote(p.title)}${p.column ? ` in ${String(p.column)}` : ''}`;
    case 'task.moved':
      return String(p.to ?? '').toLowerCase() === 'done' ? `${actor} completed ${quote(p.title)}` : `${actor} moved ${quote(p.title)} to ${String(p.to)}`;
    case 'task.updated': {
      const fields = Array.isArray(p.fields) ? (p.fields as string[]) : [];
      if (fields.length === 1 && fields[0] === 'assigneeId') return p.assignee ? `${actor} assigned ${quote(p.title)} to ${String(p.assignee)}` : `${actor} unassigned ${quote(p.title)}`;
      const names = fields.map((f) => ({ assigneeId: 'assignee', dueDate: 'due date' })[f] ?? f);
      return `${actor} updated ${names.join(', ')} of ${quote(p.title)}`;
    }
    case 'task.deleted':
      return `${actor} deleted ${quote(p.title)}`;
    case 'column.created':
      return `${actor} added the column ${quote(p.name)}`;
    case 'column.renamed':
      return `${actor} renamed ${quote(p.from)} to ${quote(p.to)}`;
    case 'board.updated':
      return `${actor} updated the board settings`;
    case 'board.reset':
      return 'The demo board was reset';
    case 'member.added':
      return `${actor} added ${String(p.name)} to the board`;
    case 'member.removed':
      return p.left ? `${String(p.name)} left the board` : `${actor} removed ${String(p.name)}`;
  }
}
