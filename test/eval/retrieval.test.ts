import { describe, expect, it } from 'vitest';
import { setupEnv } from '../helpers.js';
import { CORPUS, QUERIES, type EvalQuery } from './corpus.js';

const K = 5;

interface QueryOutcome {
  q: EvalQuery;
  top: string[];
  recall: number;
  precision: number;
  rr: number;
}

function evaluate(disableFts5: boolean) {
  const env = setupEnv();
  const dm = env.open({ disableFts5 });
  const { pm } = env.project('shopflow', dm);
  const idToKey = new Map<string, string>();
  for (const m of CORPUS) {
    const r = pm.save({
      type: m.type,
      title: m.title,
      content: m.content,
      tags: m.tags ?? [],
      importance: m.importance ?? 3,
    });
    idToKey.set(r.memory.id, m.key);
  }
  const outcomes: QueryOutcome[] = QUERIES.map((q) => {
    const top = pm.search({ query: q.query, limit: K }).results.map((r) => idToKey.get(r.memory.id)!);
    const hits = top.filter((k) => q.relevant.includes(k)).length;
    const firstRank = top.findIndex((k) => q.relevant.includes(k));
    return {
      q,
      top,
      recall: hits / q.relevant.length,
      precision: hits / K,
      rr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
    };
  });
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  const summarize = (os: QueryOutcome[]) => ({
    queries: os.length,
    recallAt5: +mean(os.map((o) => o.recall)).toFixed(3),
    precisionAt5: +mean(os.map((o) => o.precision)).toFixed(3),
    mrr: +mean(os.map((o) => o.rr)).toFixed(3),
    hitRateAt5: +mean(os.map((o) => (o.recall > 0 ? 1 : 0))).toFixed(3),
    // Best achievable Precision@5 given how many relevant memories each query has.
    precisionAt5Ceiling: +mean(os.map((o) => Math.min(o.q.relevant.length, K) / K)).toFixed(3),
  });
  return {
    engine: dm.retrieval.engine,
    all: summarize(outcomes),
    direct: summarize(outcomes.filter((o) => o.q.kind === 'direct')),
    paraphrase: summarize(outcomes.filter((o) => o.q.kind === 'paraphrase')),
    misses: outcomes
      .filter((o) => o.recall < 1)
      .map((o) => ({ query: o.q.query, expected: o.q.relevant, got: o.top })),
  };
}

describe('retrieval evaluation (Recall@5 / Precision@5)', () => {
  it('has at least 30 labelled queries over a realistic corpus', () => {
    expect(QUERIES.length).toBeGreaterThanOrEqual(30);
    const keys = new Set(CORPUS.map((m) => m.key));
    for (const q of QUERIES) for (const k of q.relevant) expect(keys.has(k), k).toBe(true);
  });

  it('FTS5 retriever: measured metrics stay above regression floors', () => {
    const r = evaluate(false);
    console.log(
      `\n[retrieval-eval] ${JSON.stringify({ engine: r.engine, all: r.all, direct: r.direct, paraphrase: r.paraphrase }, null, 2)}`,
    );
    console.log(`[retrieval-eval] misses: ${JSON.stringify(r.misses, null, 2)}`);
    // Floors are set below the measured values to catch regressions; see docs/retrieval-evaluation.md.
    expect(r.direct.recallAt5).toBeGreaterThanOrEqual(0.9);
    expect(r.all.recallAt5).toBeGreaterThanOrEqual(0.75);
    expect(r.all.mrr).toBeGreaterThanOrEqual(0.7);
  });

  it('LIKE fallback retriever: measured for comparison', () => {
    const r = evaluate(true);
    console.log(
      `\n[retrieval-eval:like] ${JSON.stringify({ engine: r.engine, all: r.all, direct: r.direct, paraphrase: r.paraphrase }, null, 2)}`,
    );
    expect(r.all.recallAt5).toBeGreaterThan(0.5);
  });
});
