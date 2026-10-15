import { describe, expect, it } from 'vitest';
import { LIMITS, registerEmbeddingProvider } from '../../src/index.js';
import { parseExpiry } from '../../src/cli/program.js';
import { setupEnv } from '../helpers.js';

describe('unicode content', () => {
  it('stores and searches CJK, emoji, RTL and accented text', () => {
    const { pm } = setupEnv().project('u');
    const cjk = pm.save({ type: 'fact', title: '数据库 选择', content: '我们 使用 PostgreSQL 数据库' }).memory
      .id;
    const emoji = pm.save({
      type: 'convention',
      title: 'Commit emoji 🚀',
      content: 'Prefix release commits with 🚀 rocket.',
    }).memory.id;
    const rtl = pm.save({ type: 'fact', title: 'مرحبا بالعالم', content: 'نص عربي للاختبار' }).memory.id;
    const accent = pm.save({
      type: 'fact',
      title: 'Café service',
      content: 'The café microservice handles orders.',
    }).memory.id;
    expect(pm.search({ query: '数据库' }).results[0]?.memory.id).toBe(cjk);
    expect(pm.search({ query: 'rocket' }).results[0]?.memory.id).toBe(emoji);
    expect(pm.search({ query: 'مرحبا' }).results[0]?.memory.id).toBe(rtl);
    expect(pm.search({ query: 'cafe' }).results[0]?.memory.id).toBe(accent); // diacritics folded
    expect(pm.get(emoji).memory.title).toBe('Commit emoji 🚀');
  });

  it('normalises NFD to NFC so visually identical text is a duplicate', () => {
    const { pm } = setupEnv().project('u');
    const nfc = 'Résumé parser';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    pm.save({ type: 'fact', title: nfc, content: 'Parses résumés' });
    expect(pm.save({ type: 'fact', title: nfd, content: 'Parses résumés'.normalize('NFD') }).status).toBe(
      'duplicate',
    );
  });

  it('strips control characters but keeps newlines and tabs', () => {
    const { pm } = setupEnv().project('u');
    const r = pm.save({
      type: 'fact',
      title: 'Ctrl\u0007 chars',
      content: 'line1\r\nline2\tTabbed\u0000\u001b[31m',
    });
    expect(r.memory.title).toBe('Ctrl chars');
    expect(r.memory.content).toBe('line1\nline2\tTabbed[31m');
  });
});

describe('large inputs and limits', () => {
  it('accepts content at the limit and rejects content above it', () => {
    const { pm } = setupEnv().project('l');
    const max = 'a '.repeat(LIMITS.contentMaxChars / 2).trim() + 'b';
    expect(pm.save({ type: 'fact', title: 'Max', content: max }).status).toBe('created');
    expect(() =>
      pm.save({ type: 'fact', title: 'Over', content: 'x'.repeat(LIMITS.contentMaxChars + 1) }),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => pm.save({ type: 'fact', title: 't'.repeat(201), content: 'c' })).toThrow();
    expect(() =>
      pm.save({
        type: 'fact',
        title: 't',
        content: 'c',
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
    expect(() => pm.search({ query: 'q'.repeat(1001) })).toThrow();
  });

  it('handles a few thousand memories with fast bounded search', () => {
    const { pm, dm } = setupEnv().project('l');
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    dm.db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        pm.save({
          type: 'fact',
          title: `Note ${i} ${words[i % 8]}`,
          content: `${words[(i * 3) % 8]} ${words[(i * 5) % 8]} body ${i}`,
        });
      }
    })();
    const t0 = performance.now();
    const r = pm.search({ query: 'gamma theta', limit: 50 });
    const ms = performance.now() - t0;
    expect(r.results).toHaveLength(50);
    expect(ms).toBeLessThan(1500);
    const ctx = pm.context({ query: 'gamma', maxTokens: 1000 });
    expect(ctx.usedTokens).toBeLessThanOrEqual(1000);
  });
});

describe('expiry policy', () => {
  it('excludes expired memories from search, list and context by default, but never deletes them', () => {
    const env = setupEnv();
    let now = new Date('2026-03-01T00:00:00Z');
    const dm = env.open({ now: () => now });
    const { pm } = env.project('e', dm);
    const t = pm.save({
      type: 'task_context',
      title: 'Sprint goal: billing',
      content: 'Finish billing refactor',
      expiresAt: '2026-03-08T00:00:00Z',
    });
    expect(pm.search({ query: 'billing' }).results).toHaveLength(1);
    now = new Date('2026-03-09T00:00:00Z');
    expect(pm.search({ query: 'billing' }).results).toHaveLength(0);
    expect(pm.list().total).toBe(0);
    expect(pm.context({ query: 'billing' }).items).toHaveLength(0);
    expect(pm.search({ query: 'billing', includeExpired: true }).results[0]?.memory.expired).toBe(true);
    expect(pm.get(t.memory.id).memory.expired).toBe(true);
    expect(pm.stats().expired).toBe(1);
    pm.update(t.memory.id, { expiresAt: null });
    expect(pm.search({ query: 'billing' }).results).toHaveLength(1);
  });

  it('parses CLI expiry durations and ISO timestamps', () => {
    const base = new Date('2026-01-01T00:00:00Z');
    expect(parseExpiry('7d', base)).toBe('2026-01-08T00:00:00.000Z');
    expect(parseExpiry('12h', base)).toBe('2026-01-01T12:00:00.000Z');
    expect(parseExpiry('2w', base)).toBe('2026-01-15T00:00:00.000Z');
    expect(parseExpiry('2026-05-01T10:00:00+02:00')).toBe('2026-05-01T08:00:00.000Z');
    expect(() => parseExpiry('soon')).toThrow(/Invalid --expires/);
  });
});

describe('optional embedding providers', () => {
  it('falls back to keyword retrieval with a warning when the configured provider is missing', () => {
    const env = setupEnv();
    const dm = env.open({ config: { embeddingProvider: 'local-onnx' } });
    const { pm } = env.project('emb', dm);
    pm.save({ type: 'fact', title: 'Search', content: 'keyword search still works' });
    expect(dm.retrieval).toMatchObject({ mode: 'keyword', semantic: false });
    expect(dm.retrieval.warnings.join(' ')).toMatch(/"local-onnx" is not available/);
    expect(pm.search({ query: 'keyword' }).results).toHaveLength(1);
    expect(pm.stats().retrieval.warnings).toHaveLength(1);
  });

  it('degrades gracefully when a provider fails to initialise', () => {
    registerEmbeddingProvider('broken', () => {
      throw new Error('model file missing');
    });
    const env = setupEnv();
    const dm = env.open({ config: { embeddingProvider: 'broken' } });
    expect(dm.retrieval.warnings.join(' ')).toMatch(/failed to initialise \(model file missing\)/);
    expect(env.project('b', dm).pm.save({ type: 'fact', title: 'ok', content: 'still works' }).status).toBe(
      'created',
    );
  });

  it('works with no provider configured (default)', () => {
    const dm = setupEnv().open();
    expect(dm.retrieval.warnings).toEqual([]);
  });
});
