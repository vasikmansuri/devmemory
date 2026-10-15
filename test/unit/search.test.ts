import { describe, expect, it } from 'vitest';
import { setupEnv } from '../helpers.js';

function seed(pm: ReturnType<ReturnType<typeof setupEnv>['project']>['pm']) {
  const ids: Record<string, string> = {};
  const add = (key: string, input: Parameters<typeof pm.save>[0]) => (ids[key] = pm.save(input).memory.id);
  add('auth', {
    type: 'architecture',
    title: 'Authentication flow',
    content: 'Login issues JWT access tokens via the auth service; refresh tokens rotate.',
    tags: ['auth'],
  });
  add('cache', {
    type: 'decision',
    title: 'Redis for caching',
    content: 'Session cache lives in Redis with 15 minute TTL.',
    tags: ['cache', 'redis'],
    importance: 4,
  });
  add('cacheLow', {
    type: 'fact',
    title: 'Old cache note',
    content: 'There used to be a memcached cache layer.',
    importance: 1,
    confidence: 0.3,
  });
  add('style', {
    type: 'convention',
    title: 'Prettier formatting',
    content: 'All TypeScript is formatted with Prettier, 110 columns.',
    tags: ['style'],
  });
  add('migr', {
    type: 'debugging',
    title: 'Migration deadlock',
    content: 'Running migrations concurrently deadlocked; migrations now run under an advisory lock.',
    tags: ['db'],
  });
  return ids as Record<'auth' | 'cache' | 'cacheLow' | 'style' | 'migr', string>;
}

describe('keyword search and ranking', () => {
  it('finds relevant memories and ranks title matches high', () => {
    const { pm } = setupEnv().project('p');
    const ids = seed(pm);
    const r = pm.search({ query: 'how does authentication work?' });
    expect(r.results[0]!.memory.id).toBe(ids.auth);
    expect(r.terms).toEqual(['authentication', 'work']);
    expect(r.results[0]!.matchedTerms).toContain('authentication');
  });

  it('uses importance and confidence as ranking signals', () => {
    const { pm } = setupEnv().project('p');
    const ids = seed(pm);
    const r = pm.search({ query: 'cache' });
    const order = r.results.map((x) => x.memory.id);
    expect(order.indexOf(ids.cache)).toBeLessThan(order.indexOf(ids.cacheLow));
    expect(r.results[0]!.breakdown.importance).toBeGreaterThan(0);
  });

  it('matches stems and prefixes (porter tokenizer)', () => {
    const { pm } = setupEnv().project('p');
    const ids = seed(pm);
    expect(pm.search({ query: 'migrating' }).results[0]?.memory.id).toBe(ids.migr);
    expect(pm.search({ query: 'deadlocks' }).results[0]?.memory.id).toBe(ids.migr);
    expect(pm.search({ query: 'format' }).results[0]?.memory.id).toBe(ids.style);
  });

  it('applies type, tag and status filters', () => {
    const { pm } = setupEnv().project('p');
    const ids = seed(pm);
    expect(pm.search({ query: 'cache', types: ['fact'] }).results.map((r) => r.memory.id)).toEqual([
      ids.cacheLow,
    ]);
    expect(pm.search({ query: 'cache', tags: ['redis'] }).results.map((r) => r.memory.id)).toEqual([
      ids.cache,
    ]);
    expect(pm.search({ query: 'cache', tags: ['redis', 'nope'] }).results).toHaveLength(0);
    pm.forget(ids.cache!, 'archive');
    expect(pm.search({ query: 'redis' }).results).toHaveLength(0);
    expect(pm.search({ query: 'redis', statuses: ['active', 'archived'] }).results).toHaveLength(1);
  });

  it('bounds result counts', () => {
    const { pm } = setupEnv().project('p');
    for (let i = 0; i < 80; i++)
      pm.save({ type: 'fact', title: `Widget ${i}`, content: `widget detail ${i}` });
    expect(pm.search({ query: 'widget', limit: 50 }).results).toHaveLength(50);
    expect(pm.search({ query: 'widget' }).results).toHaveLength(10);
    expect(() => pm.search({ query: 'widget', limit: 51 })).toThrow();
  });

  it('is safe against FTS5 query syntax injection', () => {
    const { pm } = setupEnv().project('p');
    seed(pm);
    for (const q of [
      '"unterminated',
      'auth OR',
      'NEAR(auth cache)',
      'title:auth',
      '* AND -',
      "'; DROP TABLE memories; --",
      '^auth',
      '(((',
    ]) {
      expect(() => pm.search({ query: q }), q).not.toThrow();
    }
    expect(pm.stats().total).toBe(5);
  });

  it('returns no results for stopword-only or punctuation queries without error', () => {
    const { pm } = setupEnv().project('p');
    seed(pm);
    expect(pm.search({ query: '???' }).results).toEqual([]);
    expect(() => pm.search({ query: 'the and of' })).not.toThrow();
  });

  it('removes hard-deleted memories from the FTS index (no stale entries)', () => {
    const env = setupEnv();
    const { pm, dm } = env.project('p');
    const ids = seed(pm);
    const seq = (dm.db.prepare('SELECT seq FROM memories WHERE id = ?').get(ids.migr) as { seq: number }).seq;
    pm.forget(ids.migr!, 'delete');
    expect(
      pm.search({ query: 'deadlock', statuses: ['active', 'archived', 'superseded'], includeExpired: true })
        .results,
    ).toHaveLength(0);
    expect(dm.db.prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE rowid = ?').get(seq)).toEqual({
      n: 0,
    });
    expect(
      dm.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'deadlocked'").get(),
    ).toEqual({ n: 0 });
    // Tags that only the deleted memory used are pruned; audit payloads are purged.
    expect(dm.db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'db'").get()).toEqual({ n: 0 });
    const events = dm.db
      .prepare('SELECT event, detail FROM memory_events WHERE memory_id = ?')
      .all(ids.migr) as { detail: string | null }[];
    expect(events.every((e) => e.detail === null)).toBe(true);
  });

  it('keeps the index in sync after updates to title, content and tags', () => {
    const { pm } = setupEnv().project('p');
    const ids = seed(pm);
    pm.update(ids.style!, {
      title: 'Biome formatting',
      content: 'Formatting moved from Prettier to Biome.',
      tags: ['lint'],
    });
    expect(pm.search({ query: 'biome' }).results[0]?.memory.id).toBe(ids.style);
    expect(
      pm.search({ query: '110 columns' }).results.find((r) => r.memory.id === ids.style),
    ).toBeUndefined();
    expect(pm.search({ query: 'lint' }).results[0]?.memory.id).toBe(ids.style);
  });

  it('LIKE fallback retriever works when FTS5 is unavailable', () => {
    const env = setupEnv();
    const dm = env.open({ disableFts5: true });
    const { pm } = env.project('p', dm);
    const ids = seed(pm);
    expect(dm.retrieval.engine).toBe('like-fallback');
    expect(dm.retrieval.warnings[0]).toMatch(/FTS5 unavailable/);
    expect(pm.search({ query: 'redis cache' }).results[0]?.memory.id).toBe(ids.cache);
    expect(pm.search({ query: '100%_' }).results).toEqual([]);
  });

  it('recency weighting favours recently updated memories when other signals tie', () => {
    const env = setupEnv();
    let now = new Date('2026-01-01T00:00:00Z');
    const dm = env.open({ now: () => now });
    const { pm } = env.project('p', dm);
    const old = pm.save({ type: 'fact', title: 'Deploy target alpha', content: 'deploy notes' }).memory.id;
    now = new Date('2026-06-01T00:00:00Z');
    const fresh = pm.save({ type: 'fact', title: 'Deploy target beta', content: 'deploy notes' }).memory.id;
    const withRecency = pm
      .search({ query: 'deploy target', recencyWeight: 0.5 })
      .results.map((r) => r.memory.id);
    expect(withRecency[0]).toBe(fresh);
    const r0 = pm.search({ query: 'deploy target', recencyWeight: 0 }).results;
    expect(r0.every((r) => r.breakdown.recency === 0)).toBe(true);
    expect(old).toBeDefined();
  });
});
