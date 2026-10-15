import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DevMemoryError } from '../core/errors.js';

/** True when `child` is `parent` or lies inside it (both must be absolute, normalised). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

export interface SafePathOptions {
  /** Directory the path must stay within. */
  base: string;
  /** Allow paths outside `base` (explicit user opt-in). */
  allowOutsideBase?: boolean;
  /** 'read' requires an existing regular file; 'write' requires the parent to exist. */
  mode: 'read' | 'write';
  /** For writes: permit replacing an existing file. */
  overwrite?: boolean;
}

/**
 * Resolve a user-supplied path for import/export, rejecting traversal outside `base`,
 * symlinks (at the final component, and via realpath containment for parents),
 * and non-regular files.
 */
export function resolveSafePath(userPath: string, opts: SafePathOptions): string {
  if (!userPath || userPath.includes('\0')) {
    throw new DevMemoryError('UNSAFE_PATH', 'Path is empty or contains a NUL byte');
  }
  const base = realpathSync(resolve(opts.base));
  const target = resolve(base, userPath);

  if (!opts.allowOutsideBase && !isWithin(base, target)) {
    throw new DevMemoryError('UNSAFE_PATH', `Path escapes the allowed directory: ${userPath}`, {
      hint: `Use a path inside ${base}, or pass --allow-outside-cwd to opt in explicitly.`,
    });
  }

  const parent = dirname(target);
  if (!existsSync(parent)) {
    throw new DevMemoryError('IO_ERROR', `Directory does not exist: ${parent}`);
  }
  const realParent = realpathSync(parent);
  if (!opts.allowOutsideBase && !isWithin(base, realParent)) {
    throw new DevMemoryError(
      'UNSAFE_PATH',
      `Path resolves outside the allowed directory via a symlink: ${userPath}`,
    );
  }
  const finalPath = resolve(realParent, target.slice(parent.length + 1));

  if (existsSync(finalPath) || isDanglingSymlink(finalPath)) {
    const st = lstatSync(finalPath);
    if (st.isSymbolicLink()) {
      throw new DevMemoryError('UNSAFE_PATH', `Refusing to follow symlink: ${userPath}`);
    }
    if (!st.isFile()) {
      throw new DevMemoryError('UNSAFE_PATH', `Not a regular file: ${userPath}`);
    }
    if (opts.mode === 'write' && !opts.overwrite) {
      throw new DevMemoryError('CONFLICT', `File already exists: ${userPath}`, {
        hint: 'Pass --force to overwrite.',
      });
    }
  } else if (opts.mode === 'read') {
    throw new DevMemoryError('NOT_FOUND', `File not found: ${userPath}`);
  }
  return finalPath;
}

function isDanglingSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
