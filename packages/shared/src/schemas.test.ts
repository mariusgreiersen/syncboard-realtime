import { describe, expect, it } from 'vitest';
import {
  createTaskSchema,
  normalizeLabels,
  registerSchema,
  socketMoveTaskSchema,
  taskChangesSchema,
  updateTaskSchema,
} from './schemas.js';

const ids = {
  board: '5b0a2d5e-3c1f-4d2a-9a47-7f1c0d9e5a11',
  column: '6c1b3e6f-4d20-4e3b-8b58-8a2d1e0f6b22',
  task: '7d2c4f70-5e31-4f4c-9c69-9b3e2f107c33',
};

describe('task validation', () => {
  it('applies defaults and trims the title', () => {
    const parsed = createTaskSchema.parse({ boardId: ids.board, columnId: ids.column, title: '  Ship it ' });
    expect(parsed).toMatchObject({ title: 'Ship it', description: '', priority: 'medium', assigneeId: null, dueDate: null, labels: [] });
  });

  it('rejects empty titles and invalid fields', () => {
    expect(createTaskSchema.safeParse({ boardId: ids.board, columnId: ids.column, title: '   ' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ boardId: ids.board, columnId: ids.column, title: 'x', priority: 'p0' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ boardId: ids.board, columnId: ids.column, title: 'x', dueDate: '2026-02-30' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ boardId: 'board-1', columnId: ids.column, title: 'x' }).success).toBe(false);
  });

  it('requires at least one known field in an update and rejects unknown ones', () => {
    expect(taskChangesSchema.safeParse({}).success).toBe(false);
    expect(taskChangesSchema.safeParse({ version: 9 }).success).toBe(false);
    expect(taskChangesSchema.parse({ assigneeId: null })).toEqual({ assigneeId: null });
  });

  it('requires a positive integer expected version', () => {
    const base = { boardId: ids.board, taskId: ids.task, changes: { title: 'x' } };
    expect(updateTaskSchema.safeParse({ ...base, expectedVersion: 0 }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ ...base, expectedVersion: 1.5 }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ ...base, expectedVersion: 3 }).success).toBe(true);
  });

  it('requires a mutation id on socket mutations', () => {
    const move = { boardId: ids.board, taskId: ids.task, expectedVersion: 1, toColumnId: ids.column, toIndex: 0 };
    expect(socketMoveTaskSchema.safeParse(move).success).toBe(false);
    expect(socketMoveTaskSchema.safeParse({ ...move, mutationId: crypto.randomUUID() }).success).toBe(true);
    expect(socketMoveTaskSchema.safeParse({ ...move, mutationId: crypto.randomUUID(), toIndex: -1 }).success).toBe(false);
  });
});

describe('labels', () => {
  it('trims, drops empties and de-duplicates case-insensitively', () => {
    expect(normalizeLabels([' Backend', 'backend', '', 'API ', 'api'])).toEqual(['Backend', 'API']);
  });

  it('limits the number of labels after normalisation', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `label-${i}`);
    expect(createTaskSchema.safeParse({ boardId: ids.board, columnId: ids.column, title: 'x', labels: nine }).success).toBe(false);
    const duplicates = [...Array.from({ length: 8 }, (_, i) => `l${i}`), 'L0', 'l1'];
    expect(createTaskSchema.parse({ boardId: ids.board, columnId: ids.column, title: 'x', labels: duplicates }).labels).toHaveLength(8);
  });
});

describe('registration', () => {
  it('normalises the email and enforces password length', () => {
    expect(registerSchema.parse({ email: ' Ada@Example.COM ', password: '12345678', name: 'Ada' }).email).toBe('ada@example.com');
    expect(registerSchema.safeParse({ email: 'ada@example.com', password: '1234567', name: 'Ada' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'not-an-email', password: '12345678', name: 'Ada' }).success).toBe(false);
  });
});
