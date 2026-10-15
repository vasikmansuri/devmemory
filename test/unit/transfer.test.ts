import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPORT_FORMAT, readImportFile, writeExportFile } from '../../src/index.js';
import { setupEnv, tempDir } from '../helpers.js';

describe('export and import', () => {
  it('round-trips memories, tags, statuses, links and supersede chains into another project', () => {
    const env = setupEnv();
    const dm = env.open();
    const a = env.project('src', dm);
    const m1 = a.pm.save({
      type: 'decision',
      title: 'Use Vite',
      content: 'Frontend builds with Vite.',
      tags: ['build'],
      importance: 4,
      sourceRef: 'ADR-7',
    });
    const m2 = a.pm.supersede(m1.memory.id, {
      type: 'decision',
      title: 'Use Vite 8',
      content: 'Frontend builds with Vite 8 + Rolldown.',
      tags: ['build'],
    });
    const m3 = a.pm.save({ type: 'fact', title: 'CDN', content: 'Assets served by CloudFront.' });
    a.pm.link({ fromId: m3.memory.id, toId: m2.memory.id, relation: 'depends_on' });
    a.pm.forget(m3.memory.id, 'archive');

    const doc = a.pm.exportAll();
    expect(doc).toMatchObject({ format: EXPORT_FORMAT, version: 1, project: { name: 'src' } });
    expect(doc.memories).toHaveLength(3);

    const b = env.project('dst', dm);
    const r = b.pm.importAll(JSON.parse(JSON.stringify(doc)));
    expect(r).toMatchObject({ dryRun: false, imported: 3, duplicates: 0, linksImported: 2 });
    // Ids are always re-issued.
    expect(Object.values(r.idMap)).not.toContain(m1.memory.id);
    const imported = b.pm.list({ statuses: ['active', 'superseded', 'archived'], limit: 10 }).items;
    expect(imported.map((m) => m.status).sort()).toEqual(['active', 'archived', 'superseded']);
    const old = imported.find((m) => m.title === 'Use Vite')!;
    expect(old.supersededBy).toBe(r.idMap[m2.memory.id]);
    expect(old.provenance).toMatchObject({ source: 'import', sourceRef: 'ADR-7' });
    expect(old.importance).toBe(4);
    expect(b.pm.search({ query: 'rolldown' }).results).toHaveLength(1);
  });

  it('skips duplicates on re-import and supports dry runs without writing', () => {
    const env = setupEnv();
    const { pm } = env.project('p');
    pm.save({ type: 'fact', title: 'One', content: 'first' });
    const doc = pm.exportAll();
    const dry = pm.importAll(doc, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, imported: 0, duplicates: 1 });
    const other = env.project('q').pm;
    const dry2 = other.importAll(doc, { dryRun: true });
    expect(dry2.imported).toBe(1);
    expect(other.stats().total).toBe(0);
  });

  it('re-validates and redacts imported content', () => {
    const { pm } = setupEnv().project('p');
    const r = pm.importAll({
      format: EXPORT_FORMAT,
      version: 1,
      memories: [
        { id: 'x1', type: 'fact', title: 'Leaked', content: 'token ghp_' + 'z'.repeat(36), tags: ['ok'] },
      ],
    });
    expect(r.redactions).toBe(1);
    expect(pm.list().items[0]!.content).toBe('token [REDACTED:github_token]');
  });

  it.each([
    ['not an object', 42],
    ['wrong format', { format: 'other', version: 1, memories: [] }],
    ['future version', { format: EXPORT_FORMAT, version: 2, memories: [] }],
    ['missing memories', { format: EXPORT_FORMAT, version: 1 }],
    [
      'bad status',
      {
        format: EXPORT_FORMAT,
        version: 1,
        memories: [{ id: 'a', type: 'fact', title: 't', content: 'c', status: 'deleted' }],
      },
    ],
    [
      'huge title',
      {
        format: EXPORT_FORMAT,
        version: 1,
        memories: [{ id: 'a', type: 'fact', title: 'x'.repeat(201), content: 'c' }],
      },
    ],
    [
      'bad tag',
      {
        format: EXPORT_FORMAT,
        version: 1,
        memories: [{ id: 'a', type: 'fact', title: 't', content: 'c', tags: ['bad tag!'] }],
      },
    ],
    [
      'bad date',
      {
        format: EXPORT_FORMAT,
        version: 1,
        memories: [{ id: 'a', type: 'fact', title: 't', content: 'c', createdAt: 'yesterday' }],
      },
    ],
  ])('rejects malformed import: %s (atomically)', (_name, doc) => {
    const { pm } = setupEnv().project('p');
    expect(() => pm.importAll(doc)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(pm.stats().total).toBe(0);
  });

  it('is all-or-nothing when a later record is invalid', () => {
    const { pm } = setupEnv().project('p');
    const doc = {
      format: EXPORT_FORMAT,
      version: 1,
      memories: [
        { id: 'a', type: 'fact', title: 'good', content: 'fine' },
        { id: 'b', type: 'fact', title: 'bad', content: 'fine', tags: ['ok', 'NOT OK'] },
      ],
    };
    expect(() => pm.importAll(doc)).toThrow();
    expect(pm.stats().total).toBe(0);
  });

  it('rejects unknown memory types', () => {
    const { pm } = setupEnv().project('p');
    expect(() =>
      pm.importAll({
        format: EXPORT_FORMAT,
        version: 1,
        memories: [{ id: 'a', type: 'runbook', title: 't', content: 'c' }],
      }),
    ).toThrowError(/unknown memory types: runbook/);
  });
});

describe('import/export file safety', () => {
  const doc: Parameters<typeof writeExportFile>[1] = {
    format: EXPORT_FORMAT,
    version: 1,
    memories: [],
    links: [],
  };

  it('writes exports with mode 0600 and refuses to overwrite without force', () => {
    const base = tempDir();
    const path = writeExportFile('out.json', doc, { base });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).format).toBe(EXPORT_FORMAT);
    expect(() => writeExportFile('out.json', doc, { base })).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(() => writeExportFile('out.json', doc, { base, overwrite: true })).not.toThrow();
  });

  it('blocks path traversal outside the base directory unless explicitly allowed', () => {
    const base = tempDir();
    const outside = tempDir();
    mkdirSync(join(base, 'sub'));
    for (const p of ['../escape.json', 'sub/../../escape.json', join(outside, 'abs.json')]) {
      expect(() => writeExportFile(p, doc, { base }), p).toThrowError(
        expect.objectContaining({ code: 'UNSAFE_PATH' }),
      );
      expect(() => readImportFile(p, { base }), p).toThrowError(
        expect.objectContaining({ code: 'UNSAFE_PATH' }),
      );
    }
    expect(() =>
      writeExportFile(join(outside, 'ok.json'), doc, { base, allowOutsideBase: true }),
    ).not.toThrow();
    expect(() => writeExportFile('nul\0byte.json', doc, { base })).toThrowError(/NUL/);
  });

  it('refuses to follow symlinks for reads and writes', () => {
    if (process.platform === 'win32') return;
    const base = tempDir();
    const outside = tempDir();
    const target = join(outside, 'target.json');
    writeFileSync(target, JSON.stringify(doc));
    symlinkSync(target, join(base, 'link.json'));
    expect(() => readImportFile('link.json', { base })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
    expect(() => writeExportFile('link.json', doc, { base, overwrite: true })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
    // A symlinked directory that escapes the base is also refused.
    symlinkSync(outside, join(base, 'dirlink'));
    expect(() => writeExportFile('dirlink/x.json', doc, { base })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(doc));
  });

  it('enforces the import size limit and JSON validity', () => {
    const base = tempDir();
    writeFileSync(join(base, 'big.json'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    expect(() => readImportFile('big.json', { base })).toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
    );
    writeFileSync(join(base, 'bad.json'), '{"format": ');
    expect(() => readImportFile('bad.json', { base })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => readImportFile('missing.json', { base })).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    mkdirSync(join(base, 'adir'));
    expect(() => readImportFile('adir', { base })).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
  });

  it('rejects documents with too many memories', () => {
    const { pm } = setupEnv().project('p');
    const many = Array.from({ length: 10_001 }, (_, i) => ({
      id: `m${i}`,
      type: 'fact',
      title: 't',
      content: `c${i}`,
    }));
    expect(() => pm.importAll({ format: EXPORT_FORMAT, version: 1, memories: many })).toThrowError(
      /Invalid import file/,
    );
  });
});
