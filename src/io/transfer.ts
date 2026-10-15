import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import * as z from 'zod';
import { DevMemoryError } from '../core/errors.js';
import { IsoDateSchema, LIMITS, LINK_RELATIONS, MEMORY_STATUSES } from '../core/types.js';
import { resolveSafePath } from '../security/paths.js';

export const EXPORT_FORMAT = 'devmemory-export';
export const EXPORT_VERSION = 1;

/** Lenient on unknown keys (forward compatibility) but strict on every field we use. */
export const ExportedMemorySchema = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(32),
  title: z.string().min(1).max(LIMITS.titleMaxChars),
  content: z.string().min(1).max(LIMITS.contentMaxChars),
  tags: z.array(z.string().max(LIMITS.tagMaxChars)).max(LIMITS.tagsMax).default([]),
  importance: z.int().min(1).max(5).default(3),
  confidence: z.number().min(0).max(1).default(0.8),
  status: z.enum(MEMORY_STATUSES).default('active'),
  provenance: z
    .object({
      source: z.string().max(50).optional(),
      client: z.string().max(200).nullable().optional(),
      sourceRef: z.string().max(LIMITS.sourceRefMaxChars).nullable().optional(),
    })
    .optional(),
  createdAt: IsoDateSchema.optional(),
  updatedAt: IsoDateSchema.optional(),
  expiresAt: IsoDateSchema.nullable().optional(),
  supersededBy: z.string().max(100).nullable().optional(),
});

export const ExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: IsoDateSchema.optional(),
  generator: z.string().max(100).optional(),
  project: z.object({ name: z.string().max(200) }).optional(),
  memories: z.array(ExportedMemorySchema).max(LIMITS.importMaxMemories),
  links: z
    .array(
      z.object({ fromId: z.string().max(100), toId: z.string().max(100), relation: z.enum(LINK_RELATIONS) }),
    )
    .max(LIMITS.importMaxMemories * 5)
    .default([]),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;
export type ExportFileInput = z.input<typeof ExportFileSchema>;

export function parseExportFile(data: unknown): ExportFile {
  const result = ExportFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new DevMemoryError('VALIDATION_ERROR', `Invalid import file: ${issues}`, {
      hint: `Expected a "${EXPORT_FORMAT}" v${EXPORT_VERSION} JSON document produced by \`devmemory export\`.`,
    });
  }
  return result.data;
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface FileAccessOptions {
  /** Paths must stay within this directory unless allowOutsideBase is set. */
  base: string;
  allowOutsideBase?: boolean;
}

/** Read and parse an import file with size, symlink and traversal checks. */
export function readImportFile(userPath: string, opts: FileAccessOptions): unknown {
  const path = resolveSafePath(userPath, { ...opts, mode: 'read' });
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    throw new DevMemoryError('IO_ERROR', `Cannot open ${userPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new DevMemoryError('UNSAFE_PATH', `Not a regular file: ${userPath}`);
    if (st.size > LIMITS.importMaxBytes) {
      throw new DevMemoryError(
        'LIMIT_EXCEEDED',
        `Import file is ${st.size} bytes; limit is ${LIMITS.importMaxBytes}`,
      );
    }
    const raw = readFileSync(fd, 'utf8');
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new DevMemoryError(
        'VALIDATION_ERROR',
        `Import file is not valid JSON: ${(err as Error).message}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/** Write an export file with mode 0600, refusing symlinks and (unless overwrite) existing files. */
export function writeExportFile(
  userPath: string,
  data: ExportFile,
  opts: FileAccessOptions & { overwrite?: boolean },
): string {
  const path = resolveSafePath(userPath, { ...opts, mode: 'write', overwrite: opts.overwrite ?? false });
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_TRUNC |
    O_NOFOLLOW |
    (opts.overwrite ? 0 : constants.O_EXCL);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new DevMemoryError('CONFLICT', `File already exists: ${userPath}`);
    if (code === 'ELOOP') throw new DevMemoryError('UNSAFE_PATH', `Refusing to follow symlink: ${userPath}`);
    throw new DevMemoryError('IO_ERROR', `Cannot write ${userPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return path;
}
