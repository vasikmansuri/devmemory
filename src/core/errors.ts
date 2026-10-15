/**
 * Typed errors shared by the engine, CLI and MCP layers.
 * Each code maps to a stable CLI exit code and a stable MCP error payload.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'PROJECT_NOT_INITIALIZED'
  | 'CONFLICT'
  | 'SECRET_DETECTED'
  | 'DB_BUSY'
  | 'DB_CORRUPT'
  | 'DB_VERSION_UNSUPPORTED'
  | 'DB_ERROR'
  | 'IO_ERROR'
  | 'UNSAFE_PATH'
  | 'LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

export const EXIT_CODES: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 2,
  LIMIT_EXCEEDED: 2,
  SECRET_DETECTED: 2,
  NOT_FOUND: 3,
  PROJECT_NOT_INITIALIZED: 4,
  CONFLICT: 5,
  DB_BUSY: 6,
  DB_CORRUPT: 6,
  DB_VERSION_UNSUPPORTED: 6,
  DB_ERROR: 6,
  IO_ERROR: 7,
  UNSAFE_PATH: 7,
  INTERNAL_ERROR: 1,
};

export class DevMemoryError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DevMemoryError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): { code: ErrorCode; message: string; hint?: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Translate a raw SQLite error into a DevMemoryError with an actionable hint. */
export function fromSqliteError(err: unknown, context: string): DevMemoryError {
  if (err instanceof DevMemoryError) return err;
  const code = (err as { code?: string } | null)?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
    return new DevMemoryError('DB_BUSY', `Database is locked (${context})`, {
      hint: 'Another process holds a write lock. Retry shortly; raise DEVMEMORY_BUSY_TIMEOUT_MS if this persists.',
      cause: err,
    });
  }
  if (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT')) {
    return new DevMemoryError(
      'DB_CORRUPT',
      `Database file is corrupt or not a SQLite database (${context})`,
      {
        hint: 'Run `devmemory doctor`. Restore from a backup (devmemory.db.bak-*) or move the file aside to start fresh.',
        cause: err,
      },
    );
  }
  return new DevMemoryError('DB_ERROR', `Database error (${context}): ${message}`, { cause: err });
}
