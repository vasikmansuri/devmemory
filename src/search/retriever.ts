import type Database from 'better-sqlite3';
import type { MemoryStatus } from '../core/types.js';
import { buildFtsQuery } from './query.js';

/** Filters every retriever must honour. `projectId` is mandatory: there is no cross-project path. */
export interface RetrievalFilters {
  projectId: string;
  statuses: MemoryStatus[];
  types?: string[] | undefined;
  tags?: string[] | undefined;
  includeExpired: boolean;
  now: string;
}

export interface RetrievalHit {
  seq: number;
  /** Relevance in (0, 1], normalised within this result set (1 = best text match). */
  textScore: number;
}

/**
 * Pluggable retrieval backend. v0.1 ships deterministic keyword retrievers only.
 * A future semantic retriever implements the same interface (kind: 'semantic').
 */
export interface Retriever {
  readonly name: string;
  readonly kind: 'keyword' | 'semantic';
  retrieve(terms: string[], filters: RetrievalFilters, candidateLimit: number): RetrievalHit[];
}

/** SQL WHERE fragment for the shared filters, against alias `m`. Always parameterised. */
export function filterSql(f: RetrievalFilters): { sql: string; params: unknown[] } {
  const clauses = ['m.project_id = ?'];
  const params: unknown[] = [f.projectId];
  clauses.push(`m.status IN (${f.statuses.map(() => '?').join(', ')})`);
  params.push(...f.statuses);
  if (f.types && f.types.length > 0) {
    clauses.push(`m.type IN (${f.types.map(() => '?').join(', ')})`);
    params.push(...f.types);
  }
  if (f.tags && f.tags.length > 0) {
    // Memory must carry ALL requested tags.
    clauses.push(
      `(SELECT COUNT(DISTINCT t.name) FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.memory_seq = m.seq AND t.name IN (${f.tags.map(() => '?').join(', ')})) = ?`,
    );
    params.push(...f.tags, new Set(f.tags).size);
  }
  if (!f.includeExpired) {
    clauses.push('(m.expires_at IS NULL OR m.expires_at > ?)');
    params.push(f.now);
  }
  return { sql: clauses.join(' AND '), params };
}

export class Fts5Retriever implements Retriever {
  readonly name = 'fts5-bm25';
  readonly kind = 'keyword' as const;
  constructor(private readonly db: Database.Database) {}

  retrieve(terms: string[], filters: RetrievalFilters, candidateLimit: number): RetrievalHit[] {
    const match = buildFtsQuery(terms);
    if (!match) return [];
    const where = filterSql(filters);
    // Column weights: title 3x, content 1x, tags 2x.
    const rows = this.db
      .prepare(
        `SELECT m.seq AS seq, bm25(memories_fts, 3.0, 1.0, 2.0) AS bm
           FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
          WHERE memories_fts MATCH ? AND ${where.sql}
          ORDER BY bm ASC, m.seq ASC
          LIMIT ?`,
      )
      .all(match, ...where.params, candidateLimit) as { seq: number; bm: number }[];
    // bm25() is negative; more negative = better.
    const best = Math.max(...rows.map((r) => -r.bm), 1e-9);
    return rows.map((r) => ({ seq: r.seq, textScore: Math.max(-r.bm, 0) / best || 1e-6 }));
  }
}

/** Fallback when the SQLite build lacks FTS5: substring matching with simple term-frequency scoring. */
export class LikeRetriever implements Retriever {
  readonly name = 'like-fallback';
  readonly kind = 'keyword' as const;
  constructor(private readonly db: Database.Database) {}

  retrieve(terms: string[], filters: RetrievalFilters, candidateLimit: number): RetrievalHit[] {
    if (terms.length === 0) return [];
    const where = filterSql(filters);
    const esc = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const termClauses = terms.map(
      () =>
        `(lower(m.title) LIKE ? ESCAPE '\\' OR lower(m.content) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_seq = m.seq AND t.name LIKE ? ESCAPE '\\'))`,
    );
    const termParams = terms.flatMap((t) => [esc(t), esc(t), esc(t)]);
    const rows = this.db
      .prepare(
        `SELECT m.seq AS seq, lower(m.title) AS title, lower(m.content) AS content
           FROM memories m WHERE ${where.sql} AND (${termClauses.join(' OR ')})
          LIMIT 2000`,
      )
      .all(...where.params, ...termParams) as { seq: number; title: string; content: string }[];
    const scored = rows.map((r) => {
      let s = 0;
      for (const t of terms) {
        if (r.title.includes(t)) s += 3;
        if (r.content.includes(t)) s += 1;
      }
      return { seq: r.seq, raw: s };
    });
    scored.sort((a, b) => b.raw - a.raw || a.seq - b.seq);
    const best = Math.max(...scored.map((s) => s.raw), 1);
    return scored.slice(0, candidateLimit).map((s) => ({ seq: s.seq, textScore: s.raw / best || 1e-6 }));
  }
}
