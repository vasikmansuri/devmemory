import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DevMemoryError } from '../../src/index.js';
import { setupEnv, tempDir } from '../helpers.js';

describe('project isolation', () => {
  it("never returns another project's memories through any read path", () => {
    const env = setupEnv();
    const dm = env.open();
    const a = env.project('alpha', dm);
    const b = env.project('beta', dm);
    const secret = a.pm.save({
      type: 'decision',
      title: 'Alpha private roadmap',
      content: 'Alpha launches the zephyr feature in Q3.',
      tags: ['zephyr'],
    });

    expect(
      b.pm.search({
        query: 'zephyr roadmap alpha',
        statuses: ['active', 'archived', 'superseded'],
        includeExpired: true,
      }).results,
    ).toEqual([]);
    expect(b.pm.list({ statuses: ['active', 'archived', 'superseded'], includeExpired: true }).total).toBe(0);
    expect(b.pm.context({ query: 'zephyr' }).items).toEqual([]);
    expect(b.pm.stats().total).toBe(0);
    expect(b.pm.exportAll().memories).toEqual([]);
    // Same NOT_FOUND as a non-existent id: no existence oracle.
    for (const op of [
      () => b.pm.get(secret.memory.id),
      () => b.pm.update(secret.memory.id, { title: 'hijack' }),
      () => b.pm.forget(secret.memory.id, 'delete'),
      () => b.pm.supersede(secret.memory.id, { type: 'fact', title: 'x', content: 'y' }),
    ]) {
      expect(op).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }) as DevMemoryError);
    }
    const bm = b.pm.save({ type: 'fact', title: 'Beta fact', content: 'beta' });
    expect(() => b.pm.link({ fromId: bm.memory.id, toId: secret.memory.id })).toThrowError(/not found/);
    // Alpha is untouched.
    expect(a.pm.get(secret.memory.id).memory.title).toBe('Alpha private roadmap');
  });

  it('does not treat identical content in two projects as duplicates', () => {
    const env = setupEnv();
    const dm = env.open();
    const a = env.project('a', dm);
    const b = env.project('b', dm);
    const input = { type: 'convention', title: 'Use tabs', content: 'Indent with tabs.' };
    expect(a.pm.save(input).status).toBe('created');
    expect(b.pm.save(input).status).toBe('created');
  });

  it('resolves the nearest registered ancestor directory', () => {
    const env = setupEnv();
    const dm = env.open();
    const outer = env.project('outer', dm);
    const nestedDir = join(outer.dir, 'packages', 'inner');
    mkdirSync(join(outer.dir, 'src', 'deep'), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    const inner = dm.projects.init(nestedDir, 'inner').project;
    expect(dm.projects.resolve(join(outer.dir, 'src', 'deep')).id).toBe(outer.pm.project.id);
    expect(dm.projects.resolve(nestedDir).id).toBe(inner.id);
  });

  it('throws PROJECT_NOT_INITIALIZED for unregistered directories', () => {
    const env = setupEnv();
    const dm = env.open();
    expect(() => dm.projects.resolve(tempDir())).toThrowError(
      expect.objectContaining({ code: 'PROJECT_NOT_INITIALIZED' }),
    );
  });

  it('identifies projects by canonical path, so a symlink resolves to the same project', () => {
    if (process.platform === 'win32') return;
    const env = setupEnv();
    const dm = env.open();
    const real = env.project('real', dm);
    const link = join(tempDir(), 'alias');
    symlinkSync(real.dir, link);
    expect(dm.projects.resolve(link).id).toBe(real.pm.project.id);
    expect(dm.projects.init(link).created).toBe(false);
  });
});
