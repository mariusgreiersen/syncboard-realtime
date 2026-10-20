import { z } from 'zod';
import { BOARD_ACCENTS, PRIORITIES } from './types.js';

/**
 * Runtime validation for every REST body and Socket.IO payload.
 * TypeScript types alone are not trusted at the network boundary.
 */

export const LIMITS = {
  emailMax: 254,
  passwordMin: 8,
  passwordMax: 128,
  nameMax: 60,
  boardNameMax: 80,
  boardDescriptionMax: 500,
  columnNameMax: 40,
  columnsPerBoard: 12,
  taskTitleMax: 200,
  taskDescriptionMax: 10_000,
  labelMax: 24,
  labelsPerTask: 8,
  tasksPerBoard: 500,
  membersPerBoard: 50,
  demoBoardsPerUser: 3,
} as const;

export const idSchema = z.uuid({ message: 'Must be a valid UUID' });
export const prioritySchema = z.enum(PRIORITIES);
export const accentSchema = z.enum(BOARD_ACCENTS);
export const versionSchema = z.int().min(1).max(2_147_483_647);
export const indexSchema = z.int().min(0).max(10_000);

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(LIMITS.emailMax));
const displayNameSchema = z.string().trim().min(1, 'Name is required').max(LIMITS.nameMax);
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #6366f1');

// ---------------------------------------------------------------------------
// Auth & profile
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(LIMITS.passwordMin, `Password must be at least ${LIMITS.passwordMin} characters`).max(LIMITS.passwordMax),
  name: displayNameSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(LIMITS.passwordMax),
});

export const DEMO_PERSONAS = ['alice', 'bob', 'charlie'] as const;
export type DemoPersona = (typeof DEMO_PERSONAS)[number];
export const demoLoginSchema = z.object({ persona: z.enum(DEMO_PERSONAS) });

export const updateProfileSchema = z
  .object({ name: displayNameSchema, avatarColor: hexColorSchema })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

// ---------------------------------------------------------------------------
// Boards, members, columns
// ---------------------------------------------------------------------------

const boardNameSchema = z.string().trim().min(1, 'Board name is required').max(LIMITS.boardNameMax);
const boardDescriptionSchema = z.string().trim().max(LIMITS.boardDescriptionMax);

export const createBoardSchema = z.object({
  name: boardNameSchema,
  description: boardDescriptionSchema.default(''),
  accent: accentSchema.default('indigo'),
});

export const updateBoardSchema = z
  .object({ name: boardNameSchema, description: boardDescriptionSchema, accent: accentSchema })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export const addMemberSchema = z.object({ email: emailSchema });

const columnNameSchema = z.string().trim().min(1, 'Column name is required').max(LIMITS.columnNameMax);
export const createColumnSchema = z.object({ name: columnNameSchema });
export const updateColumnSchema = z.object({ name: columnNameSchema });

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const taskTitleSchema = z.string().trim().min(1, 'Title cannot be empty').max(LIMITS.taskTitleMax);
export const taskDescriptionSchema = z.string().max(LIMITS.taskDescriptionMax);
export const dueDateSchema = z.iso.date({ message: 'Use the format YYYY-MM-DD' }).nullable();

/** Trims, drops empties and removes case-insensitive duplicates while keeping the first spelling. */
export function normalizeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (label.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
}

export const labelsSchema = z
  .array(z.string().max(LIMITS.labelMax, `Labels can be at most ${LIMITS.labelMax} characters`))
  .max(LIMITS.labelsPerTask * 2)
  .transform(normalizeLabels)
  .pipe(z.array(z.string()).max(LIMITS.labelsPerTask, `At most ${LIMITS.labelsPerTask} labels`));

export const taskFieldsSchema = z.object({
  title: taskTitleSchema,
  description: taskDescriptionSchema,
  priority: prioritySchema,
  assigneeId: idSchema.nullable(),
  dueDate: dueDateSchema,
  labels: labelsSchema,
});

export const taskChangesSchema = taskFieldsSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type TaskChanges = z.output<typeof taskChangesSchema>;

export const createTaskSchema = z.object({
  boardId: idSchema,
  columnId: idSchema,
  /** Optional client-generated id so optimistic tasks keep their identity after confirmation. */
  taskId: idSchema.optional(),
  title: taskTitleSchema,
  description: taskDescriptionSchema.default(''),
  priority: prioritySchema.default('medium'),
  assigneeId: idSchema.nullable().default(null),
  dueDate: dueDateSchema.default(null),
  labels: labelsSchema.default([]),
  /** Insert position within the column; defaults to the end. */
  index: indexSchema.optional(),
});
export type CreateTaskInput = z.output<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  boardId: idSchema,
  taskId: idSchema,
  expectedVersion: versionSchema,
  changes: taskChangesSchema,
});
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;

export const moveTaskSchema = z.object({
  boardId: idSchema,
  taskId: idSchema,
  expectedVersion: versionSchema,
  toColumnId: idSchema,
  toIndex: indexSchema,
});
export type MoveTaskInput = z.output<typeof moveTaskSchema>;

export const deleteTaskSchema = z.object({
  boardId: idSchema,
  taskId: idSchema,
  expectedVersion: versionSchema.optional(),
});
export type DeleteTaskInput = z.output<typeof deleteTaskSchema>;

// REST bodies: the board id is derived from the task on the server.
export const restCreateTaskSchema = createTaskSchema.extend({ mutationId: idSchema.optional() });
export const restUpdateTaskSchema = z.object({
  expectedVersion: versionSchema,
  changes: taskChangesSchema,
  mutationId: idSchema.optional(),
});
export const restMoveTaskSchema = z.object({
  expectedVersion: versionSchema,
  toColumnId: idSchema,
  toIndex: indexSchema,
  mutationId: idSchema.optional(),
});
export const restDeleteTaskQuerySchema = z.object({
  expectedVersion: z.coerce.number().pipe(versionSchema).optional(),
});

// ---------------------------------------------------------------------------
// Socket.IO payloads
// ---------------------------------------------------------------------------

const mutationEnvelope = { mutationId: idSchema };

export const joinBoardSchema = z.object({ boardId: idSchema });
export const leaveBoardSchema = z.object({ boardId: idSchema });
export const socketCreateTaskSchema = createTaskSchema.extend(mutationEnvelope);
export const socketUpdateTaskSchema = updateTaskSchema.extend(mutationEnvelope);
export const socketMoveTaskSchema = moveTaskSchema.extend(mutationEnvelope);
export const socketDeleteTaskSchema = deleteTaskSchema.extend(mutationEnvelope);

export const activityQuerySchema = z.object({
  limit: z.coerce.number().pipe(z.int().min(1).max(100)).default(30),
});
