import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionIndicator } from '@/components/board/ConnectionIndicator';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';
import { TaskCardView } from '@/components/kanban/TaskCard';
import { PresenceAvatars } from '@/components/presence/PresenceAvatars';
import { TooltipProvider } from '@/components/ui/menus';
import { describeActivity } from '@/lib/activity';
import { EMPTY_FILTERS } from '@/lib/filters';
import { useConnection } from '@/services/socket';
import { fromSnapshot } from '@/sync/engine';
import { DOING, TODO, snapshot, task } from '@/sync/fixtures';

const withTooltips = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
const noop = () => undefined;
const actions = { open: noop, moveTo: noop, moveBy: noop, remove: noop };

describe('ConnectionIndicator', () => {
  beforeEach(() => useConnection.setState({ status: 'connected' }));

  it.each([
    ['connected', 'synced', 'Live', 'connected'],
    ['connected', 'resyncing', 'Synchronizing…', 'synchronizing'],
    ['reconnecting', 'joining', 'Reconnecting…', 'reconnecting'],
    ['disconnected', 'joining', 'Offline', 'offline'],
  ] as const)('socket %s + phase %s shows "%s"', (status, phase, label, state) => {
    useConnection.setState({ status });
    withTooltips(<ConnectionIndicator phase={phase} />);
    const indicator = screen.getByRole('status');
    expect(indicator).toHaveTextContent(label);
    expect(indicator).toHaveAttribute('data-state', state);
  });
});

describe('PresenceAvatars', () => {
  it('shows one avatar per person and a viewer count', () => {
    withTooltips(
      <PresenceAvatars
        currentUserId="u1"
        users={[
          { id: 'u1', name: 'Alice Andersen', avatarColor: '#6366f1', connections: 1 },
          { id: 'u2', name: 'Bob Nielsen', avatarColor: '#0ea5e9', connections: 3 },
        ]}
      />,
    );
    expect(screen.getAllByTestId('presence-user')).toHaveLength(2);
    expect(screen.getByTestId('presence-count')).toHaveTextContent('2 people viewing');
    expect(screen.getByText('AA')).toBeInTheDocument();
  });

  it('says "Only you" when alone', () => {
    withTooltips(<PresenceAvatars currentUserId="u1" users={[{ id: 'u1', name: 'Alice', avatarColor: '#000000', connections: 2 }]} />);
    expect(screen.getByTestId('presence-count')).toHaveTextContent('Only you');
  });
});

describe('TaskCardView', () => {
  it('renders title, description preview, labels, priority and due date', () => {
    render(
      <TaskCardView
        task={task('t1', TODO, 0, { title: 'Ship it', description: 'All the things', labels: ['backend', 'api', 'docs', 'extra'], priority: 'urgent', dueDate: '2020-01-02' })}
        status="todo"
      />,
    );
    expect(screen.getByText('Ship it')).toBeInTheDocument();
    expect(screen.getByText('All the things')).toBeInTheDocument();
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('Urgent priority')).toBeInTheDocument();
    expect(screen.getByTitle('Overdue')).toBeInTheDocument();
  });

  it('shows a saving indicator for unconfirmed changes', () => {
    render(<TaskCardView task={task('t1', TODO, 0)} status="todo" pending />);
    expect(screen.getByTestId('card-pending')).toBeInTheDocument();
  });
});

describe('KanbanBoard', () => {
  it('renders columns in order and filters without changing the underlying counts', () => {
    const view = fromSnapshot(snapshot(10, [task('a', TODO, 0, { title: 'Alpha' }), task('b', TODO, 1, { title: 'Beta' }), task('d', DOING, 0, { title: 'Delta' })]));
    const props = { view, pendingTaskIds: new Set<string>(), disabled: false, actions, onMove: noop, onCreateTask: noop, onRenameColumn: noop, onAddColumn: noop };
    const { rerender } = render(<KanbanBoard {...props} filters={EMPTY_FILTERS} />);
    const columns = screen.getAllByTestId('kanban-column');
    expect(columns.map((c) => c.getAttribute('data-column-name'))).toEqual(['To Do', 'Doing']);
    expect(within(columns[0]!).getAllByTestId('task-card').map((c) => c.getAttribute('data-task-title'))).toEqual(['Alpha', 'Beta']);

    rerender(<KanbanBoard {...props} filters={{ ...EMPTY_FILTERS, search: 'beta' }} />);
    const todo = screen.getAllByTestId('kanban-column')[0]!;
    expect(within(todo).getAllByTestId('task-card').map((c) => c.getAttribute('data-task-title'))).toEqual(['Beta']);
    expect(within(todo).getByTestId('column-count')).toHaveTextContent('1/2');
    expect(within(screen.getAllByTestId('kanban-column')[1]!).getByText('No matching tasks')).toBeInTheDocument();
  });

  it('disables adding tasks while offline', () => {
    const view = fromSnapshot(snapshot());
    render(<KanbanBoard view={view} filters={EMPTY_FILTERS} pendingTaskIds={new Set()} disabled actions={actions} onMove={noop} onCreateTask={noop} onRenameColumn={noop} onAddColumn={noop} />);
    for (const button of screen.getAllByRole('button', { name: 'Add task' })) expect(button).toBeDisabled();
  });
});

describe('describeActivity', () => {
  const base = { id: 'x', boardId: 'b', taskId: 't', revision: 3, createdAt: '2026-10-20T10:00:00Z', actor: { id: 'u', name: 'Alice Andersen', avatarColor: '#000' } };
  it('writes readable sentences from stored activity rows', () => {
    expect(describeActivity({ ...base, actionType: 'task.moved', payload: { title: 'Auth', from: 'To Do', to: 'In Progress' } })).toBe('Alice moved “Auth” to In Progress');
    expect(describeActivity({ ...base, actionType: 'task.moved', payload: { title: 'Auth', from: 'In Progress', to: 'Done' } })).toBe('Alice completed “Auth”');
    expect(describeActivity({ ...base, actionType: 'task.updated', payload: { title: 'Auth', fields: ['assigneeId'], assignee: 'Bob Nielsen' } })).toBe('Alice assigned “Auth” to Bob Nielsen');
    expect(describeActivity({ ...base, actionType: 'task.updated', payload: { title: 'Auth', fields: ['priority', 'dueDate'] } })).toBe('Alice updated priority, due date of “Auth”');
  });
});
