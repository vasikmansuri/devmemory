import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseLogLevel, type LogLevel } from './util/logger.js';

export interface DevMemoryConfig {
  /** Directory holding the database and backups. */
  home: string;
  /** Full path to the SQLite database file. */
  dbPath: string;
  /** Milliseconds SQLite waits for a lock before failing with DB_BUSY. */
  busyTimeoutMs: number;
  logLevel: LogLevel;
  /** Extra memory categories beyond the built-ins. */
  extraTypes: string[];
  /** 'redact' replaces detected secrets; 'reject' refuses the write. */
  secretPolicy: 'redact' | 'reject';
  /** Optional embedding provider name. None ship in v0.1; requesting one falls back to keyword retrieval. */
  embeddingProvider: string | null;
}

/** Resolve configuration from environment variables with safe defaults. No config file is read. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DevMemoryConfig> = {},
): DevMemoryConfig {
  const home = resolve(overrides.home ?? env.DEVMEMORY_HOME ?? join(homedir(), '.devmemory'));
  const dbPath = resolve(overrides.dbPath ?? env.DEVMEMORY_DB ?? join(home, 'devmemory.db'));
  const busy = Number.parseInt(env.DEVMEMORY_BUSY_TIMEOUT_MS ?? '', 10);
  return {
    home,
    dbPath,
    busyTimeoutMs: overrides.busyTimeoutMs ?? (Number.isFinite(busy) && busy >= 0 ? busy : 5_000),
    logLevel: overrides.logLevel ?? parseLogLevel(env.DEVMEMORY_LOG_LEVEL),
    extraTypes:
      overrides.extraTypes ??
      (env.DEVMEMORY_EXTRA_TYPES ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    secretPolicy: overrides.secretPolicy ?? (env.DEVMEMORY_SECRET_POLICY === 'reject' ? 'reject' : 'redact'),
    embeddingProvider: overrides.embeddingProvider ?? (env.DEVMEMORY_EMBEDDINGS?.trim() || null),
  };
}
