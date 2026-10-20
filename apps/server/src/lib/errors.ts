import { HTTP_STATUS_BY_CODE, type ErrorCode, type Task, type ValidationIssue } from '@syncboard/shared';
import type { z } from 'zod';

/** Expected, user-facing failure. Anything else is treated as an internal error. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues?: ValidationIssue[];
  readonly currentTask?: Task | null;
  readonly currentVersion?: number;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { issues?: ValidationIssue[]; currentTask?: Task | null; currentVersion?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    if (extra.issues) this.issues = extra.issues;
    if (extra.currentTask !== undefined) this.currentTask = extra.currentTask;
    if (extra.currentVersion !== undefined) this.currentVersion = extra.currentVersion;
  }
}

export const errors = {
  unauthorized: (message = 'Please sign in to continue.') => new AppError('UNAUTHORIZED', message),
  forbidden: (message = 'You do not have permission to do that.') => new AppError('FORBIDDEN', message),
  /** Also used for boards the user is not a member of, so board ids cannot be probed. */
  boardNotFound: () => new AppError('BOARD_NOT_FOUND', 'Board not found.'),
  taskNotFound: () => new AppError('TASK_NOT_FOUND', 'Task not found. It may have been deleted.'),
  columnNotFound: () => new AppError('COLUMN_NOT_FOUND', 'Column not found on this board.'),
  userNotFound: (message = 'User not found.') => new AppError('USER_NOT_FOUND', message),
  conflict: (message: string) => new AppError('CONFLICT', message),
  limit: (message: string) => new AppError('LIMIT_EXCEEDED', message),
  versionConflict: (currentTask: Task | null) =>
    new AppError('VERSION_CONFLICT', 'This task was modified by another collaborator.', {
      currentTask,
      ...(currentTask ? { currentVersion: currentTask.version } : {}),
    }),
};

export function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = zodIssues(result.error);
    throw new AppError('VALIDATION_ERROR', issues[0]?.message ?? 'Invalid request.', { issues });
  }
  return result.data;
}
