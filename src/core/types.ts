import * as z from 'zod';

/** Built-in memory categories. Additional categories can be registered via `extraTypes`. */
export const BUILTIN_MEMORY_TYPES = [
  'decision',
  'architecture',
  'debugging',
  'convention',
  'constraint',
  'task_context',
  'fact',
] as const;
export type BuiltinMemoryType = (typeof BUILTIN_MEMORY_TYPES)[number];

export const MEMORY_TYPE_DESCRIPTIONS: Record<BuiltinMemoryType, string> = {
  decision: 'A technical decision and its rationale (what was chosen, why, alternatives rejected).',
  architecture: 'How the system is structured: components, boundaries, data flow.',
  debugging: 'A debugging lesson: symptom, root cause, fix, and how to recognise it again.',
  convention: 'A coding or workflow convention the project follows.',
  constraint: 'A hard constraint: compatibility, performance, legal, platform or security requirement.',
  task_context: 'Context for ongoing work: current goal, status, next steps. Often given an expiry.',
  fact: 'A general project fact that does not fit another category.',
};

export const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SOURCES = ['cli', 'mcp', 'import', 'api'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const LINK_RELATIONS = [
  'relates_to',
  'supersedes',
  'conflicts_with',
  'depends_on',
  'duplicates',
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** Hard limits. They bound memory use, response size and database growth. */
export const LIMITS = {
  titleMaxChars: 200,
  contentMaxChars: 20_000,
  tagMaxChars: 50,
  tagsMax: 20,
  sourceRefMaxChars: 500,
  queryMaxChars: 1_000,
  searchMaxResults: 50,
  listMaxPage: 200,
  contextMaxTokens: 16_000,
  contextDefaultTokens: 2_000,
  importMaxBytes: 10 * 1024 * 1024,
  importMaxMemories: 10_000,
} as const;

const TYPE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._\-/]*$/u;
const ID_PATTERN = /^mem_[0-9a-z]{10,40}$/;

export const MemoryIdSchema = z.string().regex(ID_PATTERN, 'Invalid memory id (expected mem_...)');

export const MemoryTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(TYPE_PATTERN, 'Type must be lowercase letters, digits or underscores (2-32 chars)');

export const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(LIMITS.tagMaxChars)
  .regex(
    TAG_PATTERN,
    'Tags may contain letters, digits, ".", "_", "-", "/" and must start with a letter or digit',
  );

export const IsoDateSchema = z.iso.datetime({ offset: true });

export const SaveMemoryInputSchema = z.object({
  type: MemoryTypeSchema,
  title: z.string().trim().min(1).max(LIMITS.titleMaxChars),
  content: z.string().trim().min(1).max(LIMITS.contentMaxChars),
  tags: z.array(TagSchema).max(LIMITS.tagsMax).default([]),
  importance: z.int().min(1).max(5).default(3),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceRef: z.string().trim().max(LIMITS.sourceRefMaxChars).optional(),
  expiresAt: IsoDateSchema.optional(),
  supersedes: MemoryIdSchema.optional(),
});
export type SaveMemoryInput = z.input<typeof SaveMemoryInputSchema>;

export const UpdateMemoryInputSchema = z
  .object({
    type: MemoryTypeSchema.optional(),
    title: z.string().trim().min(1).max(LIMITS.titleMaxChars).optional(),
    content: z.string().trim().min(1).max(LIMITS.contentMaxChars).optional(),
    tags: z.array(TagSchema).max(LIMITS.tagsMax).optional(),
    importance: z.int().min(1).max(5).optional(),
    confidence: z.number().min(0).max(1).optional(),
    sourceRef: z.string().trim().max(LIMITS.sourceRefMaxChars).nullable().optional(),
    expiresAt: IsoDateSchema.nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'No fields to update' });
export type UpdateMemoryInput = z.input<typeof UpdateMemoryInputSchema>;

export const SearchOptionsSchema = z.object({
  query: z.string().trim().min(1).max(LIMITS.queryMaxChars),
  types: z.array(MemoryTypeSchema).max(20).optional(),
  tags: z.array(TagSchema).max(LIMITS.tagsMax).optional(),
  statuses: z.array(z.enum(MEMORY_STATUSES)).min(1).optional(),
  includeExpired: z.boolean().default(false),
  limit: z.int().min(1).max(LIMITS.searchMaxResults).default(10),
  recencyWeight: z.number().min(0).max(1).default(0.05),
});
export type SearchOptions = z.input<typeof SearchOptionsSchema>;

export const ListOptionsSchema = z.object({
  types: z.array(MemoryTypeSchema).max(20).optional(),
  tags: z.array(TagSchema).max(LIMITS.tagsMax).optional(),
  statuses: z.array(z.enum(MEMORY_STATUSES)).min(1).optional(),
  includeExpired: z.boolean().default(false),
  limit: z.int().min(1).max(LIMITS.listMaxPage).default(20),
  offset: z.int().min(0).default(0),
  orderBy: z.enum(['updated', 'created', 'importance']).default('updated'),
});
export type ListOptions = z.input<typeof ListOptionsSchema>;

export const ContextOptionsSchema = z.object({
  query: z.string().trim().max(LIMITS.queryMaxChars).optional(),
  types: z.array(MemoryTypeSchema).max(20).optional(),
  tags: z.array(TagSchema).max(LIMITS.tagsMax).optional(),
  maxTokens: z.int().min(100).max(LIMITS.contextMaxTokens).default(LIMITS.contextDefaultTokens),
  limit: z.int().min(1).max(LIMITS.searchMaxResults).default(10),
  includeEssentials: z.boolean().default(true),
});
export type ContextOptions = z.input<typeof ContextOptionsSchema>;

export const LinkInputSchema = z.object({
  fromId: MemoryIdSchema,
  toId: MemoryIdSchema,
  relation: z.enum(LINK_RELATIONS).default('relates_to'),
});
export type LinkInput = z.input<typeof LinkInputSchema>;

export interface Provenance {
  /** Channel through which the memory entered DevMemory. */
  source: MemorySource;
  /** Client identity, e.g. "mcp:claude-code/2.1.0" or "cli". */
  client: string | null;
  /** Optional user/agent supplied reference: file path, commit, PR, URL, ticket. */
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  status: MemoryStatus;
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  expiresAt: string | null;
  expired: boolean;
  contentHash: string;
  supersededBy: string | null;
  /** Number of secrets redacted from this memory before it was stored. */
  redactions: number;
}

export interface MemoryLink {
  fromId: string;
  toId: string;
  relation: LinkRelation;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

/** Who is acting. Recorded in provenance and lifecycle events. */
export interface Actor {
  source: MemorySource;
  client?: string | null;
}
