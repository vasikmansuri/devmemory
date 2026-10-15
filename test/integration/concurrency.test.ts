import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DevMemory } from '../../src/index.js';
import { silentLogger } from '../../src/util/logger.js';
import { REPO_ROOT, cliEnv, setupEnv } from '../helpers.js';

function runWorker(
  env: NodeJS.ProcessEnv,
  projectDir: string,
  id: number,
  count: number,
): Promise<{ created: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(REPO_ROOT, 'test/fixtures/concurrent-writer.mjs'),
        join(REPO_ROOT, 'dist/index.js'),
        projectDir,
        String(id),
        String(count),
      ],
      { env },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) =>
      code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker ${id} exited ${code}: ${err}`)),
    );
  });
}

describe('concurrent writes', () => {
  it('multiple processes writing to the same database lose no writes and create no duplicates', async () => {
    const env = setupEnv();
    const { dir, dm } = env.project('conc');
    dm.close();
    const workers = 6;
    const perWorker = 30;
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) =>
        runWorker({ ...cliEnv(env.home), DEVMEMORY_BUSY_TIMEOUT_MS: '20000' }, dir, i, perWorker),
      ),
    );
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(workers * perWorker);

    const check = DevMemory.open({ logger: silentLogger, config: { home: env.home, dbPath: env.dbPath } });
    const pm = check.project(check.projects.resolve(dir));
    expect(pm.stats().total).toBe(workers * perWorker + 1); // +1 shared memory stored exactly once
    expect(pm.search({ query: 'identical content' }).results).toHaveLength(1);
    expect(pm.list({ tags: ['w3'] }).total).toBe(perWorker);
    expect(check.db.pragma('integrity_check', { simple: true })).toBe('ok');
    check.close();
  });

  it('interleaved in-process operations on two handles stay consistent', async () => {
    const env = setupEnv();
    const a = env.open();
    const b = env.open();
    const { dir } = env.project('two', a);
    const pa = a.project(a.projects.resolve(dir));
    const pb = b.project(b.projects.resolve(dir));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() =>
          (i % 2 ? pa : pb).save({ type: 'fact', title: `n${i}`, content: `interleaved ${i}` }),
        ),
      ),
    );
    expect(pa.stats().total).toBe(50);
    expect(pb.search({ query: 'interleaved', limit: 50 }).results).toHaveLength(50);
  });
});
