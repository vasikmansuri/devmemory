/**
 * Minimal structured logger that writes to stderr only.
 * stdout is reserved for MCP JSON-RPC frames and machine-readable CLI output.
 * Never pass memory content to the logger.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'warn', sink: (line: string) => void = defaultSink): Logger {
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] > ORDER[level]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }));
  };
  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
  };
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return value && value in ORDER ? (value as LogLevel) : 'warn';
}

export const silentLogger: Logger = createLogger('silent');
