import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DevMemory } from './core/engine.js';
import { ftsTableExists } from './db/connection.js';
import { LATEST_SCHEMA_VERSION, currentSchemaVersion } from './db/migrations.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Read-only health checks. With `repair`, rebuilds the FTS index if it is out of sync. */
export function runDoctor(dm: DevMemory, opts: { repair?: boolean } = {}): DoctorReport {
  const checks: DoctorCheck[] = [];
  const db = dm.db;

  const attempt = (name: string, fn: () => DoctorCheck | null) => {
    try {
      const c = fn();
      if (c) checks.push(c);
    } catch (err) {
      checks.push({ name, ok: false, detail: `check failed: ${(err as Error).message}` });
    }
  };

  attempt('sqlite_integrity', () => {
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    const ok = integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
    return {
      name: 'sqlite_integrity',
      ok,
      detail: ok
        ? 'ok'
        : integrity
            .map((r) => r.integrity_check)
            .slice(0, 5)
            .join('; '),
    };
  });

  attempt('foreign_keys', () => {
    const fk = db.pragma('foreign_key_check') as unknown[];
    return {
      name: 'foreign_keys',
      ok: fk.length === 0,
      detail: fk.length === 0 ? 'ok' : `${fk.length} violations`,
    };
  });

  attempt('schema_version', () => {
    const version = currentSchemaVersion(db);
    return {
      name: 'schema_version',
      ok: version === LATEST_SCHEMA_VERSION,
      detail: `v${version} (latest v${LATEST_SCHEMA_VERSION})`,
    };
  });

  checks.push({
    name: 'retrieval',
    ok: true,
    detail: `${dm.retrieval.engine}${dm.retrieval.warnings.length ? ` — ${dm.retrieval.warnings.join(' ')}` : ''}`,
  });

  attempt('fts_index_consistency', () => {
    if (!ftsTableExists(db)) return null;
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM memories) AS mem,
                (SELECT COUNT(*) FROM memories_fts) AS fts,
                (SELECT COUNT(*) FROM memories_fts f WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.seq = f.rowid)) AS stale`,
      )
      .get() as { mem: number; fts: number; stale: number };
    let ok = counts.mem === counts.fts && counts.stale === 0;
    let detail = `${counts.mem} memories, ${counts.fts} index rows, ${counts.stale} stale`;
    if (!ok && opts.repair) {
      rebuildFtsIndex(dm);
      ok = true;
      detail += ' — rebuilt';
    }
    return { name: 'fts_index_consistency', ok, detail };
  });

  if (dm.config.dbPath !== ':memory:' && process.platform !== 'win32' && existsSync(dm.config.dbPath)) {
    const fileMode = statSync(dm.config.dbPath).mode & 0o777;
    const dirMode = statSync(dirname(dm.config.dbPath)).mode & 0o777;
    const ok = (fileMode & 0o077) === 0 && (dirMode & 0o077) === 0;
    checks.push({
      name: 'file_permissions',
      ok,
      detail: `db ${fileMode.toString(8)}, dir ${dirMode.toString(8)}${ok ? '' : ' (expected 600 / 700)'}`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function rebuildFtsIndex(dm: DevMemory): void {
  dm.db
    .transaction(() => {
      dm.db.exec('DELETE FROM memories_fts');
      dm.db.exec(`
        INSERT INTO memories_fts(rowid, title, content, tags)
          SELECT m.seq, m.title, m.content,
                 COALESCE((SELECT group_concat(t.name, ' ') FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
                           WHERE mt.memory_seq = m.seq), '')
          FROM memories m`);
    })
    .immediate();
}
