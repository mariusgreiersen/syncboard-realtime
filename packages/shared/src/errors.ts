export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BOARD_NOT_FOUND',
  'TASK_NOT_FOUND',
  'COLUMN_NOT_FOUND',
  'USER_NOT_FOUND',
  /** Unknown route. */
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'VERSION_CONFLICT',
  'CONFLICT',
  'LIMIT_EXCEEDED',
  'RATE_LIMITED',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  /** Client-side only: no acknowledgement arrived in time. */
  'TIMEOUT',
  /** Client-side only: the socket is not connected. */
  'DISCONNECTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BOARD_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  COLUMN_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  VERSION_CONFLICT: 409,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
  DATABASE_ERROR: 503,
  INTERNAL_ERROR: 500,
  TIMEOUT: 504,
  DISCONNECTED: 503,
};

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Body of every non-2xx REST response. */
export interface ApiErrorBody {
  success: false;
  code: ErrorCode;
  message: string;
  issues?: ValidationIssue[];
  currentVersion?: number;
  currentTask?: unknown;
}
