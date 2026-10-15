import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DevMemoryError, fromSqliteError } from '../core/errors.js';
import type { Logger } from '../util/logger.js';
import { MIGRATIONS, migrate, type MigrateOptions } from './migrations.js';

export interface OpenDatabaseOptions {
  dbPath: string;
  busyTimeoutMs: number;
  logger: Logger;
  /** Force-disable FTS5 (tests the LIKE fallback). */
  disableFts5?: boolean;
  /** Test hook: stop migrating at this schema version. */
  targetSchemaVersion?: number;
}

export interface OpenedDatabase {
  db: Database.Database;
  fts5: boolean;
  migrations: { from: number; to: number; applied: string[]; backupPath: string | null };
}

const isWindows = process.platform === 'win32';

export function detectFts5(db: Database.Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x); DROP TABLE temp.__fts5_probe;');
    return true;
  } catch {
    return false;
  }
}

export function ftsTableExists(db: Database.Database): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'").get() !==
    undefined
  );
}

function currentVersionAtLeast(db: Database.Database, v: number): boolean {
  return (db.pragma('user_version', { simple: true }) as number) >= v;
}

function restrictPermissions(path: string, mode: number): void {
  if (isWindows || !existsSync(path)) return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort: some filesystems (e.g. network mounts) do not support chmod.
  }
}

export function openDatabase(opts: OpenDatabaseOptions): OpenedDatabase {
  const inMemory = opts.dbPath === ':memory:';
  if (!inMemory) {
    const dir = dirname(opts.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (existsSync(opts.dbPath) && !statSync(opts.dbPath).isFile()) {
      throw new DevMemoryError('IO_ERROR', `Database path is not a regular file: ${opts.dbPath}`);
    }
  }

  let db: Database.Database;
  try {
    db = new Database(opts.dbPath, { timeout: opts.busyTimeoutMs });
  } catch (err) {
    throw fromSqliteError(err, 'open');
  }

  try {
    // Touch the schema first so a corrupt / non-SQLite file fails fast with DB_CORRUPT.
    db.pragma('schema_version');
    if (!inMemory) db.pragma('journal_mode = WAL');
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs))}`);
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    // Overwrite deleted content on disk instead of leaving it in free pages.
    db.pragma('secure_delete = ON');
    // Do not let schema-defined functions/views run with elevated trust.
    db.pragma('trusted_schema = OFF');

    if (!inMemory) {
      restrictPermissions(dirname(opts.dbPath), 0o700);
      for (const suffix of ['', '-wal', '-shm']) restrictPermissions(opts.dbPath + suffix, 0o600);
    }

    const fts5 = !opts.disableFts5 && detectFts5(db);
    let backupPath: string | null = null;
    const migrateOpts: MigrateOptions = {
      fts5,
      ...(opts.targetSchemaVersion === undefined ? {} : { targetVersion: opts.targetSchemaVersion }),
      beforeMigrate: (fromVersion) => {
        if (inMemory) return;
        backupPath = `${opts.dbPath}.bak-v${fromVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        db.prepare('VACUUM INTO ?').run(backupPath);
        restrictPermissions(backupPath, 0o600);
        opts.logger.info('database backup created before migration', { fromVersion });
      },
    };
    const result = migrate(db, migrateOpts);
    if (result.applied.length > 0) {
      opts.logger.info('database migrated', { from: result.from, to: result.to, applied: result.applied });
    }
    let hasFtsTable = fts5 && ftsTableExists(db);
    if (fts5 && !hasFtsTable && currentVersionAtLeast(db, 2)) {
      // The database was created by a build without FTS5; build the index now.
      db.transaction(() => MIGRATIONS.find((m) => m.version === 2)!.up(db, { fts5: true })).immediate();
      hasFtsTable = true;
      opts.logger.info('built missing FTS5 index');
    }
    return { db, fts5: hasFtsTable, migrations: { ...result, backupPath } };
  } catch (err) {
    db.close();
    throw fromSqliteError(err, 'initialise');
  }
}
