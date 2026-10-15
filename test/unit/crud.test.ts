import { describe, expect, it } from 'vitest';
import { DevMemoryError } from '../../src/index.js';
import { setupEnv } from '../helpers.js';

const base = {
  type: 'decision',
  title: 'Adopt pnpm workspaces',
  content: 'Monorepo uses pnpm workspaces for speed.',
};

describe('memory CRUD', () => {
  it('saves with defaults and provenance', () => {
    const { pm } = setupEnv().project('p');
    const r = pm.save(base, { source: 'mcp', client: 'test-client/1.0' });
    expect(r.status).toBe('created');
    expect(r.memory).toMatchObject({
      type: 'decision',
      importance: 3,
      confidence: 0.8,
      status: 'active',
      tags: [],
      expiresAt: null,
      provenance: { source: 'mcp', client: 'test-client/1.0', sourceRef: null },
    });
    expect(r.memory.id).toMatch(/^mem_/);
    expect(r.memory.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises tags (lowercase, dedupe) and stores sourceRef', () => {
    const { pm } = setupEnv().project('p');
    const r = pm.save({ ...base, tags: ['Build', 'build', 'ci/cd'], sourceRef: 'docs/adr/0003.md' });
    expect(r.memory.tags).toEqual(['build', 'ci/cd']);
    expect(r.memory.provenance.sourceRef).toBe('docs/adr/0003.md');
  });

  it('rejects invalid input with VALIDATION_ERROR', () => {
    const { pm } = setupEnv().project('p');
    const bad: unknown[] = [
      { ...base, type: 'nonsense' },
      { ...base, title: '' },
      { ...base, content: '   ' },
      { ...base, importance: 9 },
      { ...base, confidence: 1.5 },
      { ...base, tags: ['has space'] },
      { ...base, expiresAt: 'tomorrow' },
      { ...base, supersedes: 'not-an-id' },
    ];
    for (const input of bad) {
      expect(() => pm.save(input as never), JSON.stringify(input)).toThrowError(DevMemoryError);
    }
  });

  it('supports extra configured types', () => {
    const env = setupEnv();
    const dm = env.open({ config: { extraTypes: ['runbook'] } });
    const { pm } = env.project('p', dm);
    expect(pm.save({ ...base, type: 'runbook' }).memory.type).toBe('runbook');
  });

  it('gets by id and tracks access', () => {
    const { pm } = setupEnv().project('p');
    const { memory } = pm.save(base);
    const got = pm.get(memory.id, { trackAccess: true });
    expect(got.memory.accessCount).toBe(1);
    expect(pm.get(memory.id).memory.lastAccessedAt).not.toBeNull();
    expect(() => pm.get('mem_doesnotexist000')).toThrowError(/not found/);
  });

  it('updates fields, keeps previous values in history', () => {
    const { pm } = setupEnv().project('p');
    const { memory } = pm.save({ ...base, tags: ['a'] });
    const r = pm.update(memory.id, {
      content: 'Monorepo uses pnpm workspaces; npm was too slow.',
      importance: 5,
      tags: ['b'],
    });
    expect(r.changed.sort()).toEqual(['content', 'importance', 'tags']);
    expect(r.memory.importance).toBe(5);
    expect(r.memory.tags).toEqual(['b']);
    const h = pm.get(memory.id, { history: true }).history.find((e) => e.event === 'updated')!;
    expect(h.detail).toMatchObject({ previous: { content: base.content, importance: 3, tags: ['a'] } });
    expect(pm.search({ query: 'slow' }).results).toHaveLength(1);
  });

  it('no-op update reports no changes; empty patch rejected', () => {
    const { pm } = setupEnv().project('p');
    const { memory } = pm.save(base);
    expect(pm.update(memory.id, { importance: 3 }).changed).toEqual([]);
    expect(() => pm.update(memory.id, {})).toThrowError(/No fields/);
  });

  it('archives (reversible) and hard-deletes', () => {
    const { pm } = setupEnv().project('p');
    const { memory } = pm.save(base);
    pm.forget(memory.id, 'archive');
    expect(pm.get(memory.id).memory.status).toBe('archived');
    expect(pm.search({ query: 'pnpm' }).results).toHaveLength(0);
    expect(pm.search({ query: 'pnpm', statuses: ['archived'] }).results).toHaveLength(1);
    pm.update(memory.id, { status: 'active' });
    expect(pm.search({ query: 'pnpm' }).results).toHaveLength(1);
    pm.forget(memory.id, 'delete');
    expect(() => pm.get(memory.id)).toThrowError(/not found/);
  });

  it('lists with filters, ordering and pagination', () => {
    const { pm } = setupEnv().project('p');
    for (let i = 0; i < 25; i++) {
      pm.save({
        type: i % 2 ? 'fact' : 'convention',
        title: `Item ${i}`,
        content: `Content number ${i}`,
        importance: (i % 5) + 1,
        tags: i < 5 ? ['early'] : [],
      });
    }
    const page1 = pm.list({ limit: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page1.nextOffset).toBe(10);
    const page3 = pm.list({ limit: 10, offset: 20 });
    expect(page3.items).toHaveLength(5);
    expect(page3.nextOffset).toBeNull();
    expect(pm.list({ types: ['fact'] }).total).toBe(12);
    expect(pm.list({ tags: ['early'] }).total).toBe(5);
    expect(pm.list({ orderBy: 'importance', limit: 1 }).items[0]!.importance).toBe(5);
    expect(() => pm.list({ limit: 1000 })).toThrowError(DevMemoryError);
  });

  it('links memories and rejects self-links and missing targets', () => {
    const { pm } = setupEnv().project('p');
    const a = pm.save(base).memory;
    const b = pm.save({ ...base, title: 'Other', content: 'Different content entirely' }).memory;
    expect(pm.link({ fromId: a.id, toId: b.id, relation: 'depends_on' }).created).toBe(true);
    expect(pm.link({ fromId: a.id, toId: b.id, relation: 'depends_on' }).created).toBe(false);
    expect(() => pm.link({ fromId: a.id, toId: a.id })).toThrowError(/itself/);
    expect(() => pm.link({ fromId: a.id, toId: 'mem_missing00000000' })).toThrowError(/not found/);
  });

  it('reports statistics', () => {
    const { pm } = setupEnv().project('p');
    pm.save({ ...base, tags: ['x'] });
    pm.save({ type: 'fact', title: 'Fact', content: 'Something true', tags: ['x', 'y'] });
    const s = pm.stats();
    expect(s.total).toBe(2);
    expect(s.byType).toEqual({ decision: 1, fact: 1 });
    expect(s.byStatus.active).toBe(2);
    expect(s.tags[0]).toEqual({ name: 'x', count: 2 });
    expect(s.retrieval).toMatchObject({ mode: 'keyword', semantic: false, engine: 'fts5-bm25' });
    expect(s.schemaVersion).toBe(2);
  });
});
