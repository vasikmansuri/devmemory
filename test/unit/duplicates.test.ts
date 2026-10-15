import { describe, expect, it } from 'vitest';
import { setupEnv } from '../helpers.js';

const m = {
  type: 'debugging',
  title: 'Flaky test caused by timezone',
  content: 'Date tests failed in CI because TZ was UTC; pin TZ in vitest config.',
};

describe('duplicate detection and conflicts', () => {
  it('returns the existing memory for an exact duplicate (explicitly, not silently)', () => {
    const { pm } = setupEnv().project('p');
    const a = pm.save(m);
    const b = pm.save(m);
    expect(b.status).toBe('duplicate');
    expect(b.memory.id).toBe(a.memory.id);
    expect(pm.stats().total).toBe(1);
  });

  it('treats whitespace-only differences as duplicates', () => {
    const { pm } = setupEnv().project('p');
    pm.save(m);
    expect(pm.save({ ...m, content: `  ${m.content.replace(/ /g, '   ')}\n\n` }).status).toBe('duplicate');
  });

  it('keeps meaningful differences: case, punctuation and type changes create new memories', () => {
    const { pm } = setupEnv().project('p');
    pm.save(m);
    expect(pm.save({ ...m, content: m.content.replace('TZ', 'tz') }).status).toBe('created');
    expect(pm.save({ ...m, content: `${m.content}!` }).status).toBe('created');
    expect(pm.save({ ...m, type: 'fact' }).status).toBe('created');
  });

  it('flags same-title memories with different content as conflicts and links them', () => {
    const { pm } = setupEnv().project('p');
    const a = pm.save({
      type: 'decision',
      title: 'Database choice',
      content: 'We use PostgreSQL 16 for all services.',
    });
    const b = pm.save({
      type: 'decision',
      title: 'database choice',
      content: 'We use MySQL 8 for every service.',
    });
    expect(b.status).toBe('created');
    expect(b.possibleConflicts.map((c) => c.id)).toContain(a.memory.id);
    expect(b.possibleConflicts[0]!.reason).toBe('same_title');
    // Both memories are preserved and the conflict surfaces in search results.
    const res = pm.search({ query: 'database choice' });
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r) => r.conflictsWith.length === 1)).toBe(true);
  });

  it('flags near-duplicate content without auto-linking', () => {
    const { pm } = setupEnv().project('p');
    const a = pm.save(m);
    const b = pm.save({
      ...m,
      title: 'Timezone flake in date tests',
      content: `${m.content} Also set TZ in CI.`,
    });
    expect(b.possibleConflicts).toEqual([
      expect.objectContaining({ id: a.memory.id, reason: 'similar_content' }),
    ]);
    expect(pm.get(b.memory.id).links).toHaveLength(0);
  });

  it('supersedes: old memory stays retrievable by id, hidden from default search', () => {
    const { pm } = setupEnv().project('p');
    const old = pm.save({ type: 'decision', title: 'Use REST', content: 'Public API is REST/JSON.' });
    const neu = pm.supersede(old.memory.id, {
      type: 'decision',
      title: 'Use GraphQL',
      content: 'Public API moved to GraphQL.',
    });
    expect(neu.supersededId).toBe(old.memory.id);
    const oldNow = pm.get(old.memory.id, { history: true });
    expect(oldNow.memory.status).toBe('superseded');
    expect(oldNow.memory.supersededBy).toBe(neu.memory.id);
    expect(oldNow.history.map((h) => h.event)).toEqual(['created', 'superseded']);
    expect(pm.search({ query: 'REST API' }).results.map((r) => r.memory.id)).toEqual([neu.memory.id]);
    expect(pm.search({ query: 'REST', statuses: ['superseded'] }).results.map((r) => r.memory.id)).toEqual([
      old.memory.id,
    ]);
    expect(pm.get(neu.memory.id).links).toEqual([
      expect.objectContaining({ relation: 'supersedes', toId: old.memory.id }),
    ]);
  });

  it('refuses to supersede an already-superseded memory or update a superseded one', () => {
    const { pm } = setupEnv().project('p');
    const a = pm.save({ type: 'fact', title: 'v1', content: 'version one' });
    pm.supersede(a.memory.id, { type: 'fact', title: 'v2', content: 'version two' });
    expect(() =>
      pm.supersede(a.memory.id, { type: 'fact', title: 'v3', content: 'version three' }),
    ).toThrowError(/already superseded/);
    expect(() => pm.update(a.memory.id, { title: 'edit' })).toThrowError(/superseded/);
  });

  it('refuses an update that would duplicate another memory', () => {
    const { pm } = setupEnv().project('p');
    const a = pm.save({ type: 'fact', title: 'A', content: 'alpha' });
    pm.save({ type: 'fact', title: 'B', content: 'beta' });
    expect(() => pm.update(a.memory.id, { title: 'B', content: 'beta' })).toThrowError(/duplicate/);
  });
});
