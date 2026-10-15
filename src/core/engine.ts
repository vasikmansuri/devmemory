import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import type * as z from 'zod';
import { loadConfig, type DevMemoryConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { currentSchemaVersion } from '../db/migrations.js';
import { EXPORT_FORMAT, EXPORT_VERSION, parseExportFile, type ExportFile } from '../io/transfer.js';
import { resolveEmbeddingProvider } from '../search/embeddings.js';
import { queryTerms } from '../search/query.js';
import {
  Fts5Retriever,
  LikeRetriever,
  filterSql,
  type RetrievalFilters,
  type Retriever,
} from '../search/retriever.js';
import { detectInstructionLikeContent } from '../security/injection.js';
import { redactSecrets } from '../security/secrets.js';
import { newId } from '../util/ids.js';
import { createLogger, type Logger } from '../util/logger.js';
import { contentHash, jaccard, normalizeText, words } from '../util/text.js';
import { packContext, type ContextItem } from './context.js';
import { DevMemoryError, fromSqliteError } from './errors.js';
import { ProjectRegistry } from './projects.js';
import {
  BUILTIN_MEMORY_TYPES,
  ContextOptionsSchema,
  LinkInputSchema,
  ListOptionsSchema,
  MemoryIdSchema,
  SaveMemoryInputSchema,
  SearchOptionsSchema,
  UpdateMemoryInputSchema,
  type Actor,
  type ContextOptions,
  type LinkInput,
  type LinkRelation,
  type ListOptions,
  type Memory,
  type MemoryLink,
  type MemoryStatus,
  type Project,
  type SaveMemoryInput,
  type SearchOptions,
  type UpdateMemoryInput,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------------------------

export interface SimilarMemory {
  id: string;
  title: string;
  type: string;
  similarity: number;
  reason: 'same_title' | 'similar_content';
}

export interface SaveResult {
  status: 'created' | 'duplicate';
  memory: Memory;
  /** Secrets removed from the input before storage. */
  redactions: { count: number; kinds: string[] };
  /** Existing active memories that may conflict with (or overlap) this one. Never auto-overwritten. */
  possibleConflicts: SimilarMemory[];
  supersededId: string | null;
}

export interface ScoreBreakdown {
  text: number;
  importance: number;
  confidence: number;
  recency: number;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  breakdown: ScoreBreakdown;
  matchedTerms: string[];
  /** Ids of memories linked to this one with relation conflicts_with (either direction). */
  conflictsWith: string[];
  instructionLike: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  terms: string[];
  retrieval: RetrievalInfo;
}

export interface RetrievalInfo {
  mode: 'keyword';
  engine: string;
  semantic: false;
  warnings: string[];
}

export interface ContextBundle {
  project: { id: string; name: string };
  text: string;
  items: {
    id: string;
    type: string;
    title: string;
    reason: ContextItem['reason'];
    score: number | null;
    truncated: boolean;
    tokens: number;
    instructionLike: boolean;
    provenance: Memory['provenance'];
  }[];
  usedTokens: number;
  maxTokens: number;
  omitted: number;
  retrieval: RetrievalInfo;
}

export interface MemoryDetails {
  memory: Memory;
  links: MemoryLink[];
  history: { event: string; actor: string | null; at: string; detail: Record<string, unknown> | null }[];
  instructionLike: boolean;
}

export interface ForgetResult {
  id: string;
  mode: 'archive' | 'delete';
  /** Memories this one had superseded; they remain superseded (not silently revived). */
  orphanedPredecessors: string[];
}

export interface ListResult {
  items: Memory[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface ProjectStats {
  project: Project;
  total: number;
  byStatus: Record<MemoryStatus, number>;
  byType: Record<string, number>;
  expired: number;
  links: number;
  tags: { name: string; count: number }[];
  oldest: string | null;
  newest: string | null;
  redactedMemories: number;
  retrieval: RetrievalInfo;
  schemaVersion: number;
  databasePath: string;
  databaseBytes: number | null;
}

export interface ImportResult {
  dryRun: boolean;
  imported: number;
  duplicates: number;
  linksImported: number;
  redactions: number;
  idMap: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

interface MemoryRow {
  seq: number;
  id: string;
  project_id: string;
  type: string;
  title: string;
  content: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  source: Memory['provenance']['source'];
  client: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
  content_hash: string;
  superseded_by: string | null;
  redactions: number;
}

/** Validate input with a Zod schema, converting failures into VALIDATION_ERROR. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new DevMemoryError('VALIDATION_ERROR', `Invalid input: ${issues}`);
  }
  return r.data;
}

/** Approximates the FTS5 porter/prefix match for explainability (exact, prefix, or shared stem). */
function termMatchesWord(term: string, word: string): boolean {
  if (word === term || word.startsWith(term)) return true;
  if (term.length < 4 || word.length < 4) return false;
  let i = 0;
  while (i < term.length && i < word.length && term[i] === word[i]) i++;
  return i >= Math.max(4, Math.ceil(Math.min(term.length, word.length) * 0.75));
}

function toIso(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new DevMemoryError('VALIDATION_ERROR', `Invalid date: ${value}`);
  return d.toISOString();
}

// ---------------------------------------------------------------------------------------------
// DevMemory: database owner
// ---------------------------------------------------------------------------------------------

export interface DevMemoryOptions {
  config?: Partial<DevMemoryConfig>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Force the LIKE fallback retriever (tests / diagnostics). */
  disableFts5?: boolean;
  /** Test hook: build an older schema. */
  targetSchemaVersion?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class DevMemory {
  readonly db: Database.Database;
  readonly config: DevMemoryConfig;
  readonly logger: Logger;
  readonly projects: ProjectRegistry;
  readonly retriever: Retriever;
  readonly retrieval: RetrievalInfo;
  readonly migrations: ReturnType<typeof openDatabase>['migrations'];
  readonly now: () => Date;
  private readonly types: Set<string>;
  private closed = false;

  private constructor(opts: DevMemoryOptions) {
    this.config = loadConfig(opts.env ?? process.env, opts.config ?? {});
    this.logger = opts.logger ?? createLogger(this.config.logLevel);
    this.now = opts.now ?? (() => new Date());
    const opened = openDatabase({
      dbPath: this.config.dbPath,
      busyTimeoutMs: this.config.busyTimeoutMs,
      logger: this.logger,
      ...(opts.disableFts5 ? { disableFts5: true } : {}),
      ...(opts.targetSchemaVersion === undefined ? {} : { targetSchemaVersion: opts.targetSchemaVersion }),
    });
    this.db = opened.db;
    this.migrations = opened.migrations;
    this.projects = new ProjectRegistry(this.db);
    this.types = new Set<string>([...BUILTIN_MEMORY_TYPES, ...this.config.extraTypes]);
    this.retriever = opened.fts5 ? new Fts5Retriever(this.db) : new LikeRetriever(this.db);
    const warnings: string[] = [];
    if (!opened.fts5) warnings.push('FTS5 unavailable: using slower LIKE-based keyword matching.');
    const emb = resolveEmbeddingProvider(this.config.embeddingProvider, this.logger);
    if (emb.warning) warnings.push(emb.warning);
    this.retrieval = { mode: 'keyword', engine: this.retriever.name, semantic: false, warnings };
  }

  static open(opts: DevMemoryOptions = {}): DevMemory {
    return new DevMemory(opts);
  }

  get memoryTypes(): string[] {
    return [...this.types];
  }

  assertType(type: string): void {
    if (!this.types.has(type)) {
      throw new DevMemoryError('VALIDATION_ERROR', `Unknown memory type "${type}"`, {
        hint: `Allowed: ${[...this.types].join(', ')}. Register more with DEVMEMORY_EXTRA_TYPES.`,
      });
    }
  }

  /** Scoped handle: every operation on it is confined to this project. */
  project(project: Project | string): ProjectMemory {
    const p = typeof project === 'string' ? this.projects.get(project) : project;
    if (!p) throw new DevMemoryError('NOT_FOUND', 'Project not found');
    return new ProjectMemory(this, p);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore: another process may hold the WAL
    }
    this.db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// ProjectMemory: all memory operations, always scoped to one project
// ---------------------------------------------------------------------------------------------

const DEFAULT_STATUSES: MemoryStatus[] = ['active'];

export class ProjectMemory {
  readonly project: Project;
  private readonly db: Database.Database;

  constructor(
    private readonly dm: DevMemory,
    project: Project,
  ) {
    this.project = project;
    this.db = dm.db;
  }

  private nowIso(): string {
    return this.dm.now().toISOString();
  }

  /** Run `fn` in an IMMEDIATE transaction, mapping SQLite errors to DevMemoryError. */
  private tx<T>(context: string, fn: () => T): T {
    try {
      return this.db.transaction(fn).immediate();
    } catch (err) {
      throw fromSqliteError(err, context);
    }
  }

  private read<T>(context: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw fromSqliteError(err, context);
    }
  }

  // ----- row helpers ------------------------------------------------------------------------

  private tagsFor(seqs: number[]): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (seqs.length === 0) return map;
    for (let i = 0; i < seqs.length; i += 500) {
      const chunk = seqs.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT mt.memory_seq AS seq, t.name AS name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
            WHERE mt.memory_seq IN (${chunk.map(() => '?').join(',')}) ORDER BY t.name`,
        )
        .all(...chunk) as { seq: number; name: string }[];
      for (const r of rows) {
        const list = map.get(r.seq) ?? [];
        list.push(r.name);
        map.set(r.seq, list);
      }
    }
    return map;
  }

  private toMemories(rows: MemoryRow[]): Memory[] {
    const tags = this.tagsFor(rows.map((r) => r.seq));
    const now = this.nowIso();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      type: r.type,
      title: r.title,
      content: r.content,
      tags: tags.get(r.seq) ?? [],
      importance: r.importance,
      confidence: r.confidence,
      status: r.status,
      provenance: {
        source: r.source,
        client: r.client,
        sourceRef: r.source_ref,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastAccessedAt: r.last_accessed_at,
      accessCount: r.access_count,
      expiresAt: r.expires_at,
      expired: r.expires_at !== null && r.expires_at <= now,
      contentHash: r.content_hash,
      supersededBy: r.superseded_by,
      redactions: r.redactions,
    }));
  }

  private row(id: string): MemoryRow {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ? AND project_id = ?')
      .get(id, this.project.id) as MemoryRow | undefined;
    // Same error whether the id is unknown or belongs to another project: no existence oracle.
    if (!row)
      throw new DevMemoryError('NOT_FOUND', `Memory ${id} not found in project "${this.project.name}"`);
    return row;
  }

  private rowsBySeq(seqs: number[]): Map<number, MemoryRow> {
    const out = new Map<number, MemoryRow>();
    for (let i = 0; i < seqs.length; i += 500) {
      const chunk = seqs.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE project_id = ? AND seq IN (${chunk.map(() => '?').join(',')})`)
        .all(this.project.id, ...chunk) as MemoryRow[];
      for (const r of rows) out.set(r.seq, r);
    }
    return out;
  }

  private setTags(seq: number, tags: string[]): void {
    this.db.prepare('DELETE FROM memory_tags WHERE memory_seq = ?').run(seq);
    const unique = [...new Set(tags)];
    const upsert = this.db.prepare(
      'INSERT INTO tags (project_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    const getId = this.db.prepare('SELECT id FROM tags WHERE project_id = ? AND name = ?');
    const link = this.db.prepare('INSERT OR IGNORE INTO memory_tags (memory_seq, tag_id) VALUES (?, ?)');
    for (const t of unique) {
      upsert.run(this.project.id, t);
      const { id } = getId.get(this.project.id, t) as { id: number };
      link.run(seq, id);
    }
    if (this.dm.retriever instanceof Fts5Retriever) {
      this.db.prepare('UPDATE memories_fts SET tags = ? WHERE rowid = ?').run(unique.join(' '), seq);
    }
    this.pruneOrphanTags();
  }

  private pruneOrphanTags(): void {
    this.db
      .prepare(
        'DELETE FROM tags WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.tag_id = tags.id)',
      )
      .run(this.project.id);
  }

  private event(
    memoryId: string,
    event: string,
    actor: Actor | null,
    detail: Record<string, unknown> | null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO memory_events (project_id, memory_id, event, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.project.id,
        memoryId,
        event,
        actor ? [actor.source, actor.client].filter(Boolean).join(':') : null,
        detail ? JSON.stringify(detail) : null,
        this.nowIso(),
      );
  }

  private addLink(fromId: string, toId: string, relation: LinkRelation): boolean {
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO memory_links (project_id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(this.project.id, fromId, toId, relation, this.nowIso()).changes > 0
    );
  }

  /** Redact secrets from user-supplied text fields, honouring the configured policy. */
  private sanitize(fields: Record<string, string | undefined | null>): {
    values: Record<string, string | undefined | null>;
    count: number;
    kinds: string[];
  } {
    const values: Record<string, string | undefined | null> = {};
    let count = 0;
    const kinds = new Set<string>();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) {
        values[k] = v;
        continue;
      }
      const r = redactSecrets(normalizeText(v));
      values[k] = r.text;
      count += r.count;
      r.kinds.forEach((x) => kinds.add(x));
    }
    if (count > 0 && this.dm.config.secretPolicy === 'reject') {
      throw new DevMemoryError(
        'SECRET_DETECTED',
        `Input contains ${count} probable secret(s): ${[...kinds].join(', ')}`,
        {
          hint: 'Remove the secret, or set DEVMEMORY_SECRET_POLICY=redact to store a redacted copy.',
          details: { kinds: [...kinds] },
        },
      );
    }
    return { values, count, kinds: [...kinds] };
  }

  private findSimilar(type: string, title: string, content: string, excludeIds: string[]): SimilarMemory[] {
    const terms = queryTerms(`${title} ${content}`).slice(0, 24);
    const hits = this.dm.retriever.retrieve(
      terms,
      {
        projectId: this.project.id,
        statuses: ['active'],
        types: [type],
        includeExpired: false,
        now: this.nowIso(),
      },
      25,
    );
    const rows = this.rowsBySeq(hits.map((h) => h.seq));
    const titleKey = words(title).join(' ');
    const out: SimilarMemory[] = [];
    for (const r of rows.values()) {
      if (excludeIds.includes(r.id)) continue;
      const sameTitle = titleKey.length > 0 && words(r.title).join(' ') === titleKey;
      const sim = jaccard(`${title} ${content}`, `${r.title} ${r.content}`);
      if (sameTitle || sim >= 0.6) {
        out.push({
          id: r.id,
          title: r.title,
          type: r.type,
          similarity: Math.round(sim * 1000) / 1000,
          reason: sameTitle ? 'same_title' : 'similar_content',
        });
      }
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  // ----- public API -------------------------------------------------------------------------

  save(input: SaveMemoryInput, actor: Actor = { source: 'api' }): SaveResult {
    const parsed = parseInput(SaveMemoryInputSchema, input);
    this.dm.assertType(parsed.type);
    const clean = this.sanitize({
      title: parsed.title,
      content: parsed.content,
      sourceRef: parsed.sourceRef,
    });
    const title = clean.values.title!;
    const content = clean.values.content!;
    if (!title || !content)
      throw new DevMemoryError('VALIDATION_ERROR', 'Title and content must not be empty');
    const tags = [...new Set(parsed.tags.map((t) => redactSecrets(t.normalize('NFC')).text))];
    const expiresAt = toIso(parsed.expiresAt);
    const hash = contentHash(parsed.type, title, content);

    return this.tx('save', () => {
      const dup = this.db
        .prepare(
          "SELECT * FROM memories WHERE project_id = ? AND content_hash = ? AND status IN ('active','archived') LIMIT 1",
        )
        .get(this.project.id, hash) as MemoryRow | undefined;
      if (dup) {
        return {
          status: 'duplicate' as const,
          memory: this.toMemories([dup])[0]!,
          redactions: { count: clean.count, kinds: clean.kinds },
          possibleConflicts: [],
          supersededId: null,
        };
      }

      let superseded: MemoryRow | null = null;
      if (parsed.supersedes) {
        superseded = this.row(parsed.supersedes);
        if (superseded.status === 'superseded') {
          throw new DevMemoryError(
            'CONFLICT',
            `Memory ${superseded.id} is already superseded by ${superseded.superseded_by}`,
            {
              hint: 'Supersede the newest version instead.',
            },
          );
        }
      }

      const possibleConflicts = this.findSimilar(
        parsed.type,
        title,
        content,
        superseded ? [superseded.id] : [],
      );
      const now = this.nowIso();
      const id = newId('mem');
      const info = this.db
        .prepare(
          `INSERT INTO memories (id, project_id, type, title, content, importance, confidence, status, source, client,
             source_ref, created_at, updated_at, expires_at, content_hash, redactions)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.project.id,
          parsed.type,
          title,
          content,
          parsed.importance,
          parsed.confidence,
          actor.source,
          actor.client ?? null,
          clean.values.sourceRef ?? null,
          now,
          now,
          expiresAt,
          hash,
          clean.count,
        );
      const seq = Number(info.lastInsertRowid);
      this.setTags(seq, tags);
      this.event(id, 'created', actor, {
        type: parsed.type,
        redactions: clean.count,
        ...(superseded ? { supersedes: superseded.id } : {}),
        ...(possibleConflicts.length ? { possibleConflicts: possibleConflicts.map((c) => c.id) } : {}),
      });

      if (superseded) {
        this.db
          .prepare(
            "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE seq = ?",
          )
          .run(id, now, superseded.seq);
        this.addLink(id, superseded.id, 'supersedes');
        this.event(superseded.id, 'superseded', actor, { by: id });
      }
      // Same title, different content: record an explicit conflict link so it surfaces on retrieval.
      for (const c of possibleConflicts.filter((x) => x.reason === 'same_title')) {
        this.addLink(id, c.id, 'conflicts_with');
      }

      return {
        status: 'created' as const,
        memory: this.toMemories([this.row(id)])[0]!,
        redactions: { count: clean.count, kinds: clean.kinds },
        possibleConflicts,
        supersededId: superseded?.id ?? null,
      };
    });
  }

  /** Replace a memory with a new version. The old one stays retrievable by id with status=superseded. */
  supersede(
    oldId: string,
    input: Omit<SaveMemoryInput, 'supersedes'>,
    actor: Actor = { source: 'api' },
  ): SaveResult {
    parseInput(MemoryIdSchema, oldId);
    return this.save({ ...input, supersedes: oldId }, actor);
  }

  get(id: string, opts: { trackAccess?: boolean; history?: boolean } = {}): MemoryDetails {
    parseInput(MemoryIdSchema, id);
    return this.read('get', () => {
      const row = this.row(id);
      if (opts.trackAccess) {
        this.db
          .prepare('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE seq = ?')
          .run(this.nowIso(), row.seq);
        row.access_count += 1;
      }
      const memory = this.toMemories([row])[0]!;
      const links = (
        this.db
          .prepare(
            'SELECT from_id, to_id, relation, created_at FROM memory_links WHERE project_id = ? AND (from_id = ? OR to_id = ?) ORDER BY created_at',
          )
          .all(this.project.id, id, id) as {
          from_id: string;
          to_id: string;
          relation: LinkRelation;
          created_at: string;
        }[]
      ).map((l) => ({ fromId: l.from_id, toId: l.to_id, relation: l.relation, createdAt: l.created_at }));
      const history = opts.history
        ? (
            this.db
              .prepare(
                'SELECT event, actor, detail, created_at FROM memory_events WHERE project_id = ? AND memory_id = ? ORDER BY id',
              )
              .all(this.project.id, id) as {
              event: string;
              actor: string | null;
              detail: string | null;
              created_at: string;
            }[]
          ).map((e) => ({
            event: e.event,
            actor: e.actor,
            at: e.created_at,
            detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null,
          }))
        : [];
      return {
        memory,
        links,
        history,
        instructionLike: detectInstructionLikeContent(`${memory.title}\n${memory.content}`),
      };
    });
  }

  update(
    id: string,
    patch: UpdateMemoryInput,
    actor: Actor = { source: 'api' },
  ): { memory: Memory; redactions: number; changed: string[] } {
    parseInput(MemoryIdSchema, id);
    const p = parseInput(UpdateMemoryInputSchema, patch);
    if (p.type) this.dm.assertType(p.type);
    const clean = this.sanitize({ title: p.title, content: p.content, sourceRef: p.sourceRef });

    return this.tx('update', () => {
      const row = this.row(id);
      if (row.status === 'superseded') {
        throw new DevMemoryError(
          'CONFLICT',
          `Memory ${id} is superseded by ${row.superseded_by}; update that one instead`,
        );
      }
      const next = {
        type: p.type ?? row.type,
        title: (clean.values.title as string | undefined) ?? row.title,
        content: (clean.values.content as string | undefined) ?? row.content,
        importance: p.importance ?? row.importance,
        confidence: p.confidence ?? row.confidence,
        source_ref: clean.values.sourceRef === undefined ? row.source_ref : (clean.values.sourceRef ?? null),
        expires_at: p.expiresAt === undefined ? row.expires_at : toIso(p.expiresAt),
        status: p.status ?? row.status,
      };
      const changed: string[] = [];
      const previous: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(next)) {
        const old = row[k as keyof MemoryRow];
        if (old !== v) {
          changed.push(k);
          previous[k] = old;
        }
      }
      const oldTags = this.tagsFor([row.seq]).get(row.seq) ?? [];
      const newTags = p.tags
        ? [...new Set(p.tags.map((t) => redactSecrets(t.normalize('NFC')).text))].sort()
        : null;
      if (newTags && newTags.join(',') !== [...oldTags].sort().join(',')) {
        changed.push('tags');
        previous.tags = oldTags;
      }
      if (changed.length === 0)
        return { memory: this.toMemories([row])[0]!, redactions: clean.count, changed };

      const hash = contentHash(next.type, next.title, next.content);
      if (hash !== row.content_hash) {
        const clash = this.db
          .prepare(
            "SELECT id FROM memories WHERE project_id = ? AND content_hash = ? AND seq != ? AND status IN ('active','archived')",
          )
          .get(this.project.id, hash, row.seq) as { id: string } | undefined;
        if (clash) {
          throw new DevMemoryError('CONFLICT', `Update would duplicate existing memory ${clash.id}`, {
            details: { duplicateOf: clash.id },
          });
        }
      }
      this.db
        .prepare(
          `UPDATE memories SET type = ?, title = ?, content = ?, importance = ?, confidence = ?, source_ref = ?,
             expires_at = ?, status = ?, content_hash = ?, updated_at = ?, redactions = redactions + ? WHERE seq = ?`,
        )
        .run(
          next.type,
          next.title,
          next.content,
          next.importance,
          next.confidence,
          next.source_ref,
          next.expires_at,
          next.status,
          hash,
          this.nowIso(),
          clean.count,
          row.seq,
        );
      if (newTags) this.setTags(row.seq, newTags);
      // Previous values are kept in the audit trail so an in-place edit never silently loses knowledge.
      this.event(id, 'updated', actor, { changed, previous, redactions: clean.count });
      return { memory: this.toMemories([this.row(id)])[0]!, redactions: clean.count, changed };
    });
  }

  forget(id: string, mode: 'archive' | 'delete' = 'archive', actor: Actor = { source: 'api' }): ForgetResult {
    parseInput(MemoryIdSchema, id);
    const result = this.tx('forget', () => {
      const row = this.row(id);
      const predecessors = (
        this.db
          .prepare('SELECT id FROM memories WHERE project_id = ? AND superseded_by = ?')
          .all(this.project.id, id) as {
          id: string;
        }[]
      ).map((r) => r.id);
      if (mode === 'archive') {
        if (row.status !== 'archived') {
          this.db
            .prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE seq = ?")
            .run(this.nowIso(), row.seq);
          this.event(id, 'archived', actor, { previousStatus: row.status });
        }
        return { id, mode, orphanedPredecessors: [] };
      }
      // Hard delete: memory row, tags, links (FK cascade), FTS row (trigger), and audit payloads.
      this.db
        .prepare('UPDATE memories SET superseded_by = NULL WHERE project_id = ? AND superseded_by = ?')
        .run(this.project.id, id);
      this.db.prepare('DELETE FROM memories WHERE seq = ?').run(row.seq);
      this.db
        .prepare('UPDATE memory_events SET detail = NULL WHERE project_id = ? AND memory_id = ?')
        .run(this.project.id, id);
      // Purge previous-value snapshots that other events may hold referencing nothing else; only this memory's.
      this.event(id, 'deleted', actor, null);
      this.pruneOrphanTags();
      return { id, mode, orphanedPredecessors: predecessors };
    });
    if (mode === 'delete') this.compactIndexes();
    return result;
  }

  /** Merge FTS segments and checkpoint the WAL so deleted text does not linger on disk. */
  private compactIndexes(): void {
    try {
      if (this.dm.retriever instanceof Fts5Retriever) {
        this.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('optimize')").run();
      }
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      this.dm.logger.warn('index compaction after delete failed', { error: (err as Error).message });
    }
  }

  list(opts: ListOptions = {}): ListResult {
    const o = parseInput(ListOptionsSchema, opts);
    return this.read('list', () => {
      const where = filterSql(this.filters(o.statuses, o.types, o.tags, o.includeExpired));
      const order =
        o.orderBy === 'created'
          ? 'm.created_at DESC, m.seq DESC'
          : o.orderBy === 'importance'
            ? 'm.importance DESC, m.updated_at DESC, m.seq DESC'
            : 'm.updated_at DESC, m.seq DESC';
      const total = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${where.sql}`).get(...where.params) as {
          n: number;
        }
      ).n;
      const rows = this.db
        .prepare(`SELECT m.* FROM memories m WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...where.params, o.limit, o.offset) as MemoryRow[];
      const items = this.toMemories(rows);
      return {
        items,
        total,
        limit: o.limit,
        offset: o.offset,
        nextOffset: o.offset + items.length < total ? o.offset + items.length : null,
      };
    });
  }

  private filters(
    statuses: MemoryStatus[] | undefined,
    types: string[] | undefined,
    tags: string[] | undefined,
    includeExpired: boolean,
  ): RetrievalFilters {
    return {
      projectId: this.project.id,
      statuses: statuses ?? DEFAULT_STATUSES,
      types,
      tags,
      includeExpired,
      now: this.nowIso(),
    };
  }

  search(opts: SearchOptions): SearchResponse {
    const o = parseInput(SearchOptionsSchema, opts);
    return this.read('search', () => {
      const terms = queryTerms(o.query);
      const hits = this.dm.retriever.retrieve(
        terms,
        this.filters(o.statuses, o.types, o.tags, o.includeExpired),
        Math.max(o.limit * 5, 50),
      );
      const rows = this.rowsBySeq(hits.map((h) => h.seq));
      const memories = new Map(this.toMemories([...rows.values()]).map((m) => [m.id, m]));
      const nowMs = this.dm.now().getTime();
      const scored: SearchResult[] = [];
      for (const h of hits) {
        const row = rows.get(h.seq);
        if (!row) continue;
        const memory = memories.get(row.id)!;
        const ageDays = Math.max(0, (nowMs - new Date(memory.updatedAt).getTime()) / 86_400_000);
        const breakdown: ScoreBreakdown = {
          text: 0.7 * h.textScore,
          importance: 0.15 * ((memory.importance - 1) / 4),
          confidence: 0.1 * memory.confidence,
          recency: o.recencyWeight * Math.exp(-ageDays / 90),
        };
        const score = breakdown.text + breakdown.importance + breakdown.confidence + breakdown.recency;
        const haystack = new Set(words(`${memory.title} ${memory.content} ${memory.tags.join(' ')}`));
        scored.push({
          memory,
          score: Math.round(score * 10_000) / 10_000,
          breakdown: Object.fromEntries(
            Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 10_000) / 10_000]),
          ) as unknown as ScoreBreakdown,
          matchedTerms: terms.filter((t) => [...haystack].some((w) => termMatchesWord(t, w))),
          conflictsWith: [],
          instructionLike: detectInstructionLikeContent(`${memory.title}\n${memory.content}`),
        });
      }
      scored.sort((a, b) => b.score - a.score || (a.memory.id < b.memory.id ? -1 : 1));
      const results = scored.slice(0, o.limit);
      this.attachConflicts(results);
      return { results, terms, retrieval: this.dm.retrieval };
    });
  }

  private attachConflicts(results: SearchResult[]): void {
    if (results.length === 0) return;
    const ids = results.map((r) => r.memory.id);
    const ph = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id FROM memory_links WHERE project_id = ? AND relation = 'conflicts_with'
           AND (from_id IN (${ph}) OR to_id IN (${ph}))`,
      )
      .all(this.project.id, ...ids, ...ids) as { from_id: string; to_id: string }[];
    for (const r of results) {
      r.conflictsWith = rows
        .filter((l) => l.from_id === r.memory.id || l.to_id === r.memory.id)
        .map((l) => (l.from_id === r.memory.id ? l.to_id : l.from_id));
    }
  }

  context(opts: ContextOptions = {}): ContextBundle {
    const o = parseInput(ContextOptionsSchema, opts);
    const items: ContextItem[] = [];
    const seen = new Set<string>();
    const push = (m: Memory, reason: ContextItem['reason'], score: number | null) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      items.push({
        memory: m,
        reason,
        score,
        instructionLike: detectInstructionLikeContent(`${m.title}\n${m.content}`),
      });
    };

    if (o.query && queryTerms(o.query).length > 0) {
      const res = this.search({ query: o.query, types: o.types, tags: o.tags, limit: o.limit });
      for (const r of res.results) push(r.memory, 'match', r.score);
    }
    if (o.includeEssentials) {
      const essentials = this.list({
        types: o.types,
        tags: o.tags,
        orderBy: 'importance',
        limit: 10,
      }).items.filter(
        (m) =>
          m.importance >= 5 || (m.importance >= 4 && (m.type === 'constraint' || m.type === 'convention')),
      );
      for (const m of essentials) push(m, 'essential', null);
    }
    if (items.length === 0 && !o.query) {
      for (const m of this.list({ types: o.types, tags: o.tags, orderBy: 'updated', limit: o.limit }).items) {
        push(m, 'recent', null);
      }
    }

    const packed = packContext(this.project.name, items, o.maxTokens, this.nowIso());
    if (packed.included.length > 0) {
      const now = this.nowIso();
      this.tx('context-access', () => {
        const stmt = this.db.prepare(
          'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ? AND project_id = ?',
        );
        for (const inc of packed.included) stmt.run(now, inc.item.memory.id, this.project.id);
      });
    }
    return {
      project: { id: this.project.id, name: this.project.name },
      text: packed.text,
      items: packed.included.map(({ item, truncated, tokens }) => ({
        id: item.memory.id,
        type: item.memory.type,
        title: item.memory.title,
        reason: item.reason,
        score: item.score,
        truncated,
        tokens,
        instructionLike: item.instructionLike,
        provenance: item.memory.provenance,
      })),
      usedTokens: packed.usedTokens,
      maxTokens: o.maxTokens,
      omitted: packed.omitted,
      retrieval: this.dm.retrieval,
    };
  }

  link(input: LinkInput, actor: Actor = { source: 'api' }): { link: MemoryLink; created: boolean } {
    const l = parseInput(LinkInputSchema, input);
    if (l.fromId === l.toId) throw new DevMemoryError('VALIDATION_ERROR', 'Cannot link a memory to itself');
    return this.tx('link', () => {
      this.row(l.fromId);
      this.row(l.toId);
      const created = this.addLink(l.fromId, l.toId, l.relation);
      if (created) this.event(l.fromId, 'linked', actor, { to: l.toId, relation: l.relation });
      return {
        link: { fromId: l.fromId, toId: l.toId, relation: l.relation, createdAt: this.nowIso() },
        created,
      };
    });
  }

  stats(): ProjectStats {
    return this.read('stats', () => {
      const pid = this.project.id;
      const byStatus: Record<MemoryStatus, number> = { active: 0, superseded: 0, archived: 0 };
      for (const r of this.db
        .prepare('SELECT status, COUNT(*) AS n FROM memories WHERE project_id = ? GROUP BY status')
        .all(pid) as { status: MemoryStatus; n: number }[]) {
        byStatus[r.status] = r.n;
      }
      const byType: Record<string, number> = {};
      for (const r of this.db
        .prepare('SELECT type, COUNT(*) AS n FROM memories WHERE project_id = ? GROUP BY type ORDER BY type')
        .all(pid) as { type: string; n: number }[]) {
        byType[r.type] = r.n;
      }
      const agg = this.db
        .prepare(
          `SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest,
                  SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
                  SUM(CASE WHEN redactions > 0 THEN 1 ELSE 0 END) AS redacted
             FROM memories WHERE project_id = ?`,
        )
        .get(this.nowIso(), pid) as {
        total: number;
        oldest: string | null;
        newest: string | null;
        expired: number | null;
        redacted: number | null;
      };
      const links = (
        this.db.prepare('SELECT COUNT(*) AS n FROM memory_links WHERE project_id = ?').get(pid) as {
          n: number;
        }
      ).n;
      const tags = this.db
        .prepare(
          `SELECT t.name AS name, COUNT(*) AS count FROM tags t JOIN memory_tags mt ON mt.tag_id = t.id
            WHERE t.project_id = ? GROUP BY t.name ORDER BY count DESC, t.name LIMIT 20`,
        )
        .all(pid) as { name: string; count: number }[];
      let databaseBytes: number | null;
      try {
        databaseBytes = this.dm.config.dbPath === ':memory:' ? null : statSync(this.dm.config.dbPath).size;
      } catch {
        databaseBytes = null;
      }
      return {
        project: this.project,
        total: agg.total,
        byStatus,
        byType,
        expired: agg.expired ?? 0,
        links,
        tags,
        oldest: agg.oldest,
        newest: agg.newest,
        redactedMemories: agg.redacted ?? 0,
        retrieval: this.dm.retrieval,
        schemaVersion: currentSchemaVersion(this.db),
        databasePath: this.dm.config.dbPath,
        databaseBytes,
      };
    });
  }

  exportAll(): ExportFile {
    return this.read('export', () => {
      const rows = this.db
        .prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY seq')
        .all(this.project.id) as MemoryRow[];
      const memories = this.toMemories(rows).map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        content: m.content,
        tags: m.tags,
        importance: m.importance,
        confidence: m.confidence,
        status: m.status,
        provenance: {
          source: m.provenance.source,
          client: m.provenance.client,
          sourceRef: m.provenance.sourceRef,
        },
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        expiresAt: m.expiresAt,
        supersededBy: m.supersededBy,
      }));
      const links = (
        this.db
          .prepare(
            'SELECT from_id, to_id, relation FROM memory_links WHERE project_id = ? ORDER BY from_id, to_id',
          )
          .all(this.project.id) as { from_id: string; to_id: string; relation: LinkRelation }[]
      ).map((l) => ({ fromId: l.from_id, toId: l.to_id, relation: l.relation }));
      return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: this.nowIso(),
        generator: 'devmemory',
        project: { name: this.project.name },
        memories,
        links,
      };
    });
  }

  /**
   * Import an export document into THIS project. All-or-nothing (single transaction).
   * Every record is re-validated and re-redacted; ids are always re-issued so an import
   * can never overwrite or impersonate existing memories.
   */
  importAll(
    data: unknown,
    opts: { dryRun?: boolean } = {},
    actor: Actor = { source: 'import' },
  ): ImportResult {
    const doc = parseExportFile(data);
    const unknownTypes = [...new Set(doc.memories.map((m) => m.type))].filter(
      (t) => !this.dm.memoryTypes.includes(t),
    );
    if (unknownTypes.length) {
      throw new DevMemoryError(
        'VALIDATION_ERROR',
        `Import contains unknown memory types: ${unknownTypes.join(', ')}`,
        {
          hint: 'Register them with DEVMEMORY_EXTRA_TYPES before importing.',
        },
      );
    }
    const ROLLBACK = Symbol('dry-run');
    let result: ImportResult | null = null;
    try {
      this.tx('import', () => {
        const idMap: Record<string, string> = {};
        let imported = 0;
        let duplicates = 0;
        let redactions = 0;
        const pending: { newId: string; supersededBy: string | null }[] = [];
        const insert = this.db.prepare(
          `INSERT INTO memories (id, project_id, type, title, content, importance, confidence, status, source, client,
             source_ref, created_at, updated_at, expires_at, content_hash, redactions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = this.nowIso();
        for (const m of doc.memories) {
          const typeOk = parseInput(SaveMemoryInputSchema.shape.type, m.type);
          const clean = this.sanitize({
            title: m.title,
            content: m.content,
            sourceRef: m.provenance?.sourceRef ?? null,
            client: m.provenance?.client ?? null,
          });
          const title = clean.values.title!;
          const content = clean.values.content!;
          if (!title || !content)
            throw new DevMemoryError('VALIDATION_ERROR', `Memory ${m.id}: empty title or content`);
          const tags = parseInput(SaveMemoryInputSchema.shape.tags, m.tags);
          const hash = contentHash(typeOk, title, content);
          const dup = this.db
            .prepare('SELECT id FROM memories WHERE project_id = ? AND content_hash = ? LIMIT 1')
            .get(this.project.id, hash) as { id: string } | undefined;
          if (dup) {
            idMap[m.id] = dup.id;
            duplicates++;
            continue;
          }
          const id = newId('mem');
          const info = insert.run(
            id,
            this.project.id,
            typeOk,
            title,
            content,
            m.importance,
            m.confidence,
            m.status,
            clean.values.client ?? null,
            clean.values.sourceRef ?? null,
            toIso(m.createdAt) ?? now,
            toIso(m.updatedAt) ?? now,
            toIso(m.expiresAt ?? null),
            hash,
            clean.count,
          );
          this.setTags(Number(info.lastInsertRowid), tags);
          this.event(id, 'imported', actor, {
            originalId: m.id,
            originalSource: m.provenance?.source ?? null,
          });
          idMap[m.id] = id;
          pending.push({ newId: id, supersededBy: m.supersededBy ?? null });
          imported++;
          redactions += clean.count;
        }
        for (const p of pending) {
          if (p.supersededBy && idMap[p.supersededBy]) {
            this.db
              .prepare('UPDATE memories SET superseded_by = ? WHERE id = ?')
              .run(idMap[p.supersededBy], p.newId);
          }
        }
        let linksImported = 0;
        for (const l of doc.links) {
          const from = idMap[l.fromId];
          const to = idMap[l.toId];
          if (from && to && from !== to && this.addLink(from, to, l.relation)) linksImported++;
        }
        result = { dryRun: !!opts.dryRun, imported, duplicates, linksImported, redactions, idMap };
        if (opts.dryRun) throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK && (err as { cause?: unknown }).cause !== ROLLBACK) throw err;
    }
    return result!;
  }
}
