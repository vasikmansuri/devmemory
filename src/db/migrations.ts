import type Database from 'better-sqlite3';
import { DevMemoryError } from '../core/errors.js';

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database, caps: { fts5: boolean }): void;
}

/**
 * Append-only list. Never edit a released migration; add a new one.
 * Each migration runs inside its own transaction together with its bookkeeping row.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          root_path   TEXT NOT NULL UNIQUE,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE memories (
          seq              INTEGER PRIMARY KEY,
          id               TEXT NOT NULL UNIQUE,
          project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          type             TEXT NOT NULL,
          title            TEXT NOT NULL,
          content          TEXT NOT NULL,
          importance       INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          confidence       REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
          status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
          source           TEXT NOT NULL,
          client           TEXT,
          source_ref       TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          last_accessed_at TEXT,
          access_count     INTEGER NOT NULL DEFAULT 0,
          expires_at       TEXT,
          content_hash     TEXT NOT NULL,
          superseded_by    TEXT,
          redactions       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_memories_project_status ON memories(project_id, status, updated_at DESC);
        CREATE INDEX idx_memories_project_type ON memories(project_id, type);
        CREATE INDEX idx_memories_project_hash ON memories(project_id, content_hash);
        CREATE INDEX idx_memories_project_expires ON memories(project_id, expires_at) WHERE expires_at IS NOT NULL;

        CREATE TABLE tags (
          id          INTEGER PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          UNIQUE (project_id, name)
        );

        CREATE TABLE memory_tags (
          memory_seq  INTEGER NOT NULL REFERENCES memories(seq) ON DELETE CASCADE,
          tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (memory_seq, tag_id)
        ) WITHOUT ROWID;
        CREATE INDEX idx_memory_tags_tag ON memory_tags(tag_id);

        CREATE TABLE memory_links (
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          from_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          to_id       TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          relation    TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          PRIMARY KEY (from_id, to_id, relation)
        ) WITHOUT ROWID;
        CREATE INDEX idx_memory_links_to ON memory_links(to_id);

        -- Lifecycle audit trail. Never stores secrets (inputs are redacted first).
        -- On hard delete, detail payloads for that memory are purged.
        CREATE TABLE memory_events (
          id          INTEGER PRIMARY KEY,
          project_id  TEXT NOT NULL,
          memory_id   TEXT NOT NULL,
          event       TEXT NOT NULL,
          actor       TEXT,
          detail      TEXT,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX idx_memory_events_memory ON memory_events(memory_id);
        CREATE INDEX idx_memory_events_project ON memory_events(project_id, created_at);
      `);
    },
  },
  {
    version: 2,
    name: 'fts5_search_index',
    up(db, caps) {
      if (!caps.fts5) return; // LIKE fallback retriever is used instead.
      db.exec(`
        -- rowid mirrors memories.seq (an INTEGER PRIMARY KEY, so it is stable across VACUUM).
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, content, tags,
          tokenize = 'porter unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.seq, new.title, new.content, '');
        END;
        CREATE TRIGGER memories_fts_au AFTER UPDATE OF title, content ON memories BEGIN
          UPDATE memories_fts SET title = new.title, content = new.content WHERE rowid = new.seq;
        END;
        CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.seq;
        END;

        INSERT INTO memories_fts(rowid, title, content, tags)
          SELECT m.seq, m.title, m.content,
                 COALESCE((SELECT group_concat(t.name, ' ') FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
                           WHERE mt.memory_seq = m.seq), '')
          FROM memories m;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function currentSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export interface MigrateOptions {
  fts5: boolean;
  /** Stop after this version (used by tests to build old schemas). */
  targetVersion?: number;
  /** Called once before the first pending migration on a non-empty database. */
  beforeMigrate?: (fromVersion: number) => void;
}

export function migrate(
  db: Database.Database,
  opts: MigrateOptions,
): { from: number; to: number; applied: string[] } {
  const from = currentSchemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new DevMemoryError(
      'DB_VERSION_UNSUPPORTED',
      `Database schema v${from} is newer than this DevMemory build supports (v${LATEST_SCHEMA_VERSION})`,
      { hint: 'Upgrade DevMemory. Downgrading a database is not supported.' },
    );
  }
  const target = opts.targetVersion ?? LATEST_SCHEMA_VERSION;
  const pending = MIGRATIONS.filter((m) => m.version > from && m.version <= target);
  if (pending.length === 0) return { from, to: from, applied: [] };

  if (from > 0) opts.beforeMigrate?.(from);

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied: string[] = [];
  for (const m of pending) {
    db.transaction(() => {
      m.up(db, { fts5: opts.fts5 });
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.pragma(`user_version = ${m.version}`);
    }).immediate();
    applied.push(`${m.version}_${m.name}`);
  }
  return { from, to: target, applied };
}
