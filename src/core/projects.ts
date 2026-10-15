import type Database from 'better-sqlite3';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DevMemoryError } from './errors.js';
import type { Project } from './types.js';
import { newId } from '../util/ids.js';
import { normalizeText } from '../util/text.js';

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  rootPath: r.root_path,
  createdAt: r.created_at,
});

/** Canonical absolute path (symlinks resolved, real casing on case-insensitive filesystems). */
export function canonicalDir(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    throw new DevMemoryError('NOT_FOUND', `Directory does not exist: ${abs}`);
  }
  const real = realpathSync.native(abs);
  if (!statSync(real).isDirectory()) {
    throw new DevMemoryError('VALIDATION_ERROR', `Not a directory: ${abs}`);
  }
  return real;
}

/**
 * Projects are identified by the canonical path of their root directory, stored only in the
 * local database. Nothing is written into the repository, so a cloned repo cannot claim another
 * project's identity.
 */
export class ProjectRegistry {
  constructor(private readonly db: Database.Database) {}

  init(rootDir: string, name?: string): { project: Project; created: boolean } {
    const rootPath = canonicalDir(rootDir);
    const existing = this.findByRoot(rootPath);
    if (existing) return { project: existing, created: false };
    const cleanName = normalizeText(name ?? basename(rootPath) ?? 'project').slice(0, 100) || 'project';
    const now = new Date().toISOString();
    const id = newId('prj');
    this.db
      .prepare('INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, cleanName, rootPath, now, now);
    return { project: { id, name: cleanName, rootPath, createdAt: now }, created: true };
  }

  findByRoot(rootPath: string): Project | null {
    const row = this.db
      .prepare('SELECT id, name, root_path, created_at FROM projects WHERE root_path = ?')
      .get(rootPath) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  get(id: string): Project | null {
    const row = this.db
      .prepare('SELECT id, name, root_path, created_at FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return (
      this.db
        .prepare('SELECT id, name, root_path, created_at FROM projects ORDER BY name')
        .all() as ProjectRow[]
    ).map(toProject);
  }

  /** Find the registered project containing `startDir` (nearest ancestor wins). */
  resolve(startDir: string): Project {
    let dir = canonicalDir(startDir);
    for (;;) {
      const p = this.findByRoot(dir);
      if (p) return p;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new DevMemoryError('PROJECT_NOT_INITIALIZED', `No DevMemory project found for ${startDir}`, {
      hint: 'Run `devmemory init` in the project root, or pass --project <dir>.',
    });
  }

  /** Remove a project and all of its memories (cascades). */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }
}
