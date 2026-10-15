import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setupEnv } from '../helpers.js';

describe('persistence across restarts', () => {
  it('memories, tags, links and events survive closing and reopening the database', () => {
    const env = setupEnv();
    const { dir, pm, dm } = env.project('alpha');
    const a = pm.save({
      type: 'decision',
      title: 'Use Postgres for billing',
      content: 'ACID guarantees needed.',
      tags: ['db'],
    });
    const b = pm.save({
      type: 'constraint',
      title: 'Node 22 minimum',
      content: 'Runtime must be Node >= 22.',
    });
    pm.link({ fromId: a.memory.id, toId: b.memory.id });
    dm.close();

    const dm2 = env.open();
    const pm2 = dm2.project(dm2.projects.resolve(dir));
    const got = pm2.get(a.memory.id, { history: true });
    expect(got.memory.title).toBe('Use Postgres for billing');
    expect(got.memory.tags).toEqual(['db']);
    expect(got.links).toHaveLength(1);
    expect(got.history.map((h) => h.event)).toContain('created');
    expect(pm2.search({ query: 'postgres billing' }).results[0]?.memory.id).toBe(a.memory.id);
    expect(pm2.stats().total).toBe(2);
  });

  it('creates the database with restrictive permissions (POSIX)', () => {
    if (process.platform === 'win32') return;
    const env = setupEnv();
    env.project('perm');
    expect(statSync(env.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(env.home).mode & 0o777).toBe(0o700);
  });

  it('uses WAL journal mode and foreign keys', () => {
    const env = setupEnv();
    const dm = env.open();
    expect(dm.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(dm.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(dm.db.pragma('secure_delete', { simple: true })).toBe(1);
  });

  it('project init is idempotent and keyed by canonical path', () => {
    const env = setupEnv();
    const { dir, dm } = env.project('idem');
    const again = dm.projects.init(`${dir}/./`);
    expect(again.created).toBe(false);
    expect(dm.projects.list()).toHaveLength(1);
  });
});
