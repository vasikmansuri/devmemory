import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DevMemory, runDoctor } from '../../src/index.js';
import { LATEST_SCHEMA_VERSION } from '../../src/db/migrations.js';
import { silentLogger } from '../../src/util/logger.js';
import { setupEnv, tempDir } from '../helpers.js';

describe('schema migrations', () => {
  it('creates the latest schema on a fresh database and records applied migrations', () => {
    const env = setupEnv();
    const dm = env.open();
    expect(dm.db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(dm.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'fts5_search_index' },
    ]);
    expect(dm.migrations.backupPath).toBeNull();
  });

  it('upgrades a v1 database in place: backs it up first and backfills the search index', () => {
    const env = setupEnv();
    const v1 = env.open({ targetSchemaVersion: 1 });
    const { pm, dir } = env.project('legacy', v1);
    expect(v1.db.pragma('user_version', { simple: true })).toBe(1);
    pm.save({
      type: 'decision',
      title: 'Legacy decision about kafka',
      content: 'Events go through Kafka.',
      tags: ['events'],
    });
    v1.close();

    const v2 = env.open();
    expect(v2.migrations.applied).toEqual(['2_fts5_search_index']);
    expect(v2.migrations.backupPath).not.toBeNull();
    expect(existsSync(v2.migrations.backupPath!)).toBe(true);
    const pm2 = v2.project(v2.projects.resolve(dir));
    expect(pm2.search({ query: 'kafka' }).results).toHaveLength(1);
    expect(pm2.search({ query: 'events' }).results).toHaveLength(1); // tags backfilled
    // The backup is a valid v1 database.
    const backup = new Database(v2.migrations.backupPath!, { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(1);
    backup.close();
  });

  it('refuses to open a database from a newer DevMemory version', () => {
    const env = setupEnv();
    env.open().close();
    const raw = new Database(env.dbPath);
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => env.open()).toThrowError(expect.objectContaining({ code: 'DB_VERSION_UNSUPPORTED' }));
  });

  it('builds a missing FTS index when a database created without FTS5 is reopened with it', () => {
    const env = setupEnv();
    const noFts = env.open({ disableFts5: true });
    const { pm, dir } = env.project('x', noFts);
    pm.save({ type: 'fact', title: 'Ports', content: 'Grafana runs on port 3000.' });
    noFts.close();
    const withFts = env.open();
    expect(withFts.retrieval.engine).toBe('fts5-bm25');
    expect(withFts.project(withFts.projects.resolve(dir)).search({ query: 'grafana' }).results).toHaveLength(
      1,
    );
  });
});

describe('database failure handling', () => {
  it('reports a corrupt / non-SQLite file as DB_CORRUPT with a hint', () => {
    const home = tempDir();
    const dbPath = join(home, 'devmemory.db');
    writeFileSync(dbPath, 'this is definitely not a sqlite database'.repeat(200));
    let err: unknown;
    try {
      DevMemory.open({ logger: silentLogger, config: { home, dbPath } });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'DB_CORRUPT' });
    expect((err as { hint: string }).hint).toMatch(/doctor/);
  });

  it('reports a truncated database as DB_CORRUPT', () => {
    const env = setupEnv();
    const { pm } = env.project('t');
    for (let i = 0; i < 200; i++) pm.save({ type: 'fact', title: `fact ${i}`, content: 'x'.repeat(500) + i });
    pm.stats();
    const dm = DevMemory.open({ logger: silentLogger, config: { home: env.home, dbPath: env.dbPath } });
    dm.close();
    // Overwrite the middle of the file with garbage.
    const buf = Buffer.alloc(8192, 0xab);
    const fd = openSync(env.dbPath, 'r+');
    writeSync(fd, buf, 0, buf.length, 8192);
    closeSync(fd);
    let code: string | undefined;
    try {
      const again = DevMemory.open({ logger: silentLogger, config: { home: env.home, dbPath: env.dbPath } });
      const report = runDoctor(again);
      code = report.ok ? 'OK' : 'DOCTOR_FAILED';
      again.close();
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(['DB_CORRUPT', 'DOCTOR_FAILED']).toContain(code);
  });

  it('fails with DB_BUSY when another connection holds the write lock past the timeout', () => {
    const env = setupEnv();
    const dm = env.open({ config: { busyTimeoutMs: 50 } });
    const { pm } = env.project('lock', dm);
    const locker = new Database(env.dbPath);
    locker.exec('BEGIN EXCLUSIVE');
    try {
      expect(() =>
        pm.save({ type: 'fact', title: 'blocked', content: 'should not be written' }),
      ).toThrowError(expect.objectContaining({ code: 'DB_BUSY' }));
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    expect(pm.save({ type: 'fact', title: 'unblocked', content: 'written after lock release' }).status).toBe(
      'created',
    );
  });

  it('rejects a database path that is a directory', () => {
    const home = tempDir();
    expect(() => DevMemory.open({ logger: silentLogger, config: { home, dbPath: home } })).toThrowError(
      expect.objectContaining({ code: 'IO_ERROR' }),
    );
  });
});

describe('doctor', () => {
  it('passes on a healthy database', () => {
    const env = setupEnv();
    const { pm, dm } = env.project('d');
    pm.save({ type: 'fact', title: 'Healthy', content: 'All good' });
    const r = runDoctor(dm);
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['sqlite_integrity', 'foreign_keys', 'schema_version', 'fts_index_consistency']),
    );
    expect(r.ok).toBe(true);
  });

  it('detects and repairs stale search index entries', () => {
    const env = setupEnv();
    const { pm, dm } = env.project('d');
    pm.save({ type: 'fact', title: 'Real', content: 'real memory' });
    dm.db
      .prepare(
        "INSERT INTO memories_fts(rowid, title, content, tags) VALUES (99999, 'ghost', 'stale ghost row', '')",
      )
      .run();
    expect(runDoctor(dm).ok).toBe(false);
    const repaired = runDoctor(dm, { repair: true });
    expect(repaired.ok).toBe(true);
    expect(dm.db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get()).toEqual({ n: 1 });
    expect(pm.search({ query: 'real' }).results).toHaveLength(1);
  });

  it('flags world-readable database files', () => {
    if (process.platform === 'win32') return;
    const env = setupEnv();
    const { dm } = env.project('d');
    chmodSync(env.dbPath, 0o644);
    const check = runDoctor(dm).checks.find((c) => c.name === 'file_permissions')!;
    expect(check.ok).toBe(false);
    expect(readdirSync(env.home)).toContain('devmemory.db');
  });
});
