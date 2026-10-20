import { BOARD_ROLES, PRIORITIES } from '@syncboard/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * PostgreSQL is the source of truth for all durable data. Presence is NOT stored here.
 *
 * Two constraints are added by a hand-written migration because Drizzle cannot express
 * them declaratively (see drizzle/0001_ordering_constraints.sql):
 *   - UNIQUE (column_id, position) DEFERRABLE INITIALLY DEFERRED on tasks
 *   - UNIQUE (board_id, position)  DEFERRABLE INITIALLY DEFERRED on columns
 * They let a transaction renumber positions freely while guaranteeing that no two
 * tasks ever share a slot once the transaction commits.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const taskPriority = pgEnum('task_priority', PRIORITIES);
export const boardRole = pgEnum('board_role', BOARD_ROLES);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lower-cased. */
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    avatarColor: text('avatar_color').notNull(),
    /** Demo accounts can only collaborate on demo boards (see docs/security.md). */
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the random session token; the token itself only lives in the HTTP-only cookie. */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const boards = pgTable(
  'boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    accent: text('accent').notNull().default('indigo'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Incremented by every committed board mutation. The UPDATE that increments it also
     * takes the board's row lock, which serialises all writers of one board.
     */
    revision: integer('revision').notNull().default(0),
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    index('boards_owner_id_idx').on(table.ownerId),
    check('boards_revision_non_negative', sql`${table.revision} >= 0`),
  ],
);

export const boardMembers = pgTable(
  'board_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: boardRole('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('board_members_board_user_key').on(table.boardId, table.userId),
    index('board_members_user_id_idx').on(table.userId),
  ],
);

export const columns = pgTable(
  'columns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    ...timestamps,
  },
  (table) => [
    // Target of the composite foreign key from tasks: a task's column must belong to the task's board.
    unique('columns_id_board_id_key').on(table.id, table.boardId),
    check('columns_position_non_negative', sql`${table.position} >= 0`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: uuid('column_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priority: taskPriority('priority').notNull().default('medium'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    dueDate: date('due_date', { mode: 'string' }),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    position: integer('position').notNull(),
    version: integer('version').notNull().default(1),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'tasks_column_board_fk',
      columns: [table.columnId, table.boardId],
      foreignColumns: [columns.id, columns.boardId],
    }).onDelete('cascade'),
    index('tasks_board_id_idx').on(table.boardId),
    index('tasks_assignee_id_idx').on(table.assigneeId),
    check('tasks_position_non_negative', sql`${table.position} >= 0`),
    check('tasks_version_positive', sql`${table.version} >= 1`),
    check('tasks_title_length', sql`char_length(${table.title}) between 1 and 200`),
  ],
);

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    /** Not a foreign key: history outlives deleted tasks (the title is kept in the payload). */
    taskId: uuid('task_id'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actionType: text('action_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    revision: integer('revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('activity_events_board_created_idx').on(table.boardId, table.createdAt.desc())],
);

/**
 * Idempotency ledger: a retried mutation with a known id returns the stored result
 * instead of executing twice. Rows are pruned after 24 hours.
 */
export const processedMutations = pgTable(
  'processed_mutations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('processed_mutations_created_at_idx').on(table.createdAt)],
);

export type UserRow = typeof users.$inferSelect;
export type BoardRow = typeof boards.$inferSelect;
export type ColumnRow = typeof columns.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type BoardMemberRow = typeof boardMembers.$inferSelect;
export type ActivityRow = typeof activityEvents.$inferSelect;
