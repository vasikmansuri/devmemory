import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { DevMemory, type DevMemoryOptions, type ProjectMemory } from '../src/index.js';
import { silentLogger } from '../src/util/logger.js';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      // best effort
    }
  }
});

/** A fresh temp directory removed after the test. Real path (macOS /var -> /private/var). */
export function tempDir(prefix = 'dm-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface Env {
  home: string;
  dbPath: string;
  open: (opts?: DevMemoryOptions) => DevMemory;
  /** Create (and init) a project directory, returning a scoped handle on a new DevMemory. */
  project: (name: string, dm?: DevMemory) => { dir: string; pm: ProjectMemory; dm: DevMemory };
}

export function setupEnv(): Env {
  const home = tempDir('dm-home-');
  const workspace = tempDir('dm-ws-');
  const dbPath = join(home, 'devmemory.db');
  const opened: DevMemory[] = [];
  cleanups.push(() => opened.forEach((d) => d.close()));
  const open = (opts: DevMemoryOptions = {}) => {
    const dm = DevMemory.open({ logger: silentLogger, ...opts, config: { home, dbPath, ...opts.config } });
    opened.push(dm);
    return dm;
  };
  return {
    home,
    dbPath,
    open,
    project: (name, dm = open()) => {
      const dir = join(workspace, name);
      mkdirSync(dir, { recursive: true });
      const { project } = dm.projects.init(dir, name);
      return { dir, pm: dm.project(project), dm };
    },
  };
}

export function cliEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, DEVMEMORY_HOME: home, DEVMEMORY_LOG_LEVEL: 'error', DEVMEMORY_PROJECT: '' };
}
