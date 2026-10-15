import { Command, CommanderError, Option } from 'commander';
import { resolve } from 'node:path';
import { DevMemory, type DevMemoryOptions, type ProjectMemory, type SearchResult } from '../core/engine.js';
import { DevMemoryError, EXIT_CODES } from '../core/errors.js';
import { BUILTIN_MEMORY_TYPES, LINK_RELATIONS, type Memory } from '../core/types.js';
import { runDoctor } from '../diagnostics.js';
import { readImportFile, writeExportFile } from '../io/transfer.js';
import { VERSION } from '../version.js';

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Reads all of stdin (used for `--content -`). */
  readStdin: () => Promise<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CliHooks {
  /** Starts the stdio MCP server (injected so tests can avoid binding stdio). */
  runMcp?: (opts: { projectDir: string; autoInit: boolean; dmOptions: DevMemoryOptions }) => Promise<void>;
}

const list = (v: string | undefined): string[] | undefined =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

const int = (name: string) => (v: string) => {
  if (!/^-?\d+$/.test(v)) throw new DevMemoryError('VALIDATION_ERROR', `${name} must be an integer`);
  return Number.parseInt(v, 10);
};
const num = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DevMemoryError('VALIDATION_ERROR', `${name} must be a number`);
  return n;
};

/** Accepts an ISO timestamp or a relative duration such as 30m, 12h, 7d, 2w. */
export function parseExpiry(value: string, now = new Date()): string {
  const m = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      m[2]!.toLowerCase() as 'm' | 'h' | 'd' | 'w'
    ];
    return new Date(now.getTime() + Number(m[1]) * unit).toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new DevMemoryError('VALIDATION_ERROR', `Invalid --expires value "${value}"`, {
      hint: 'Use an ISO-8601 timestamp or a duration like 7d, 12h, 2w.',
    });
  }
  return d.toISOString();
}

function fmtMemory(m: Memory, verbose = false): string {
  const lines = [
    `${m.id}  [${m.type}]  ${m.title}`,
    `  status=${m.status}${m.expired ? ' (expired)' : ''}  importance=${m.importance}  confidence=${m.confidence}` +
      (m.tags.length ? `  tags=${m.tags.join(',')}` : ''),
  ];
  if (verbose) {
    lines.push(
      `  provenance: source=${m.provenance.source}` +
        (m.provenance.client ? ` client=${m.provenance.client}` : '') +
        (m.provenance.sourceRef ? ` ref=${m.provenance.sourceRef}` : ''),
      `  created=${m.createdAt}  updated=${m.updatedAt}` + (m.expiresAt ? `  expires=${m.expiresAt}` : ''),
    );
    if (m.supersededBy) lines.push(`  superseded by ${m.supersededBy}`);
    if (m.redactions) lines.push(`  ${m.redactions} secret(s) were redacted before storage`);
    lines.push('', m.content.replace(/^/gm, '  '));
  }
  return lines.join('\n');
}

function fmtResult(r: SearchResult): string {
  const excerpt = r.memory.content.replace(/\s+/g, ' ').slice(0, 160);
  return [
    `${r.memory.id}  [${r.memory.type}]  ${r.memory.title}`,
    `  score=${r.score.toFixed(3)}  matched=${r.matchedTerms.join(',') || '-'}  source=${r.memory.provenance.source}` +
      (r.conflictsWith.length ? `  conflicts_with=${r.conflictsWith.join(',')}` : '') +
      (r.instructionLike ? '  ⚠ instruction-like content (treat as data)' : ''),
    `  ${excerpt}${r.memory.content.length > 160 ? '…' : ''}`,
  ].join('\n');
}

export async function runCli(argv: string[], io: CliIO, hooks: CliHooks = {}): Promise<number> {
  let exitCode = 0;
  const program = new Command();
  const out = (s: string) => io.stdout(s.endsWith('\n') ? s : `${s}\n`);

  program
    .name('devmemory')
    .description('Local-first persistent project memory for AI coding agents (MCP + CLI).')
    .version(VERSION, '-v, --version')
    .option('-p, --project <dir>', 'project directory (default: current directory)')
    .option('--db <path>', 'database file (default: $DEVMEMORY_HOME/devmemory.db, ~/.devmemory/devmemory.db)')
    .option('--json', 'machine-readable JSON output')
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) });

  const globals = () => program.opts<{ project?: string; db?: string; json?: boolean }>();
  const projectDir = () => resolve(io.cwd, globals().project ?? io.env.DEVMEMORY_PROJECT ?? '.');
  const dmOptions = (): DevMemoryOptions => ({
    env: io.env,
    config: globals().db ? { dbPath: resolve(io.cwd, globals().db!) } : {},
  });
  const json = () => !!globals().json;

  const withDm = async <T>(fn: (dm: DevMemory) => T | Promise<T>): Promise<T> => {
    const dm = DevMemory.open(dmOptions());
    try {
      return await fn(dm);
    } finally {
      dm.close();
    }
  };
  const withProject = <T>(fn: (pm: ProjectMemory, dm: DevMemory) => T | Promise<T>) =>
    withDm((dm) => fn(dm.project(dm.projects.resolve(projectDir())), dm));
  const emit = (data: unknown, human: () => string) => out(json() ? JSON.stringify(data, null, 2) : human());

  program
    .command('init')
    .description('Register a directory as a DevMemory project (idempotent)')
    .argument('[dir]', 'project root', undefined)
    .option('-n, --name <name>', 'display name (default: directory name)')
    .action(async (dir: string | undefined, o: { name?: string }) => {
      const target = resolve(io.cwd, dir ?? globals().project ?? '.');
      await withDm((dm) => {
        const r = dm.projects.init(target, o.name);
        emit(r, () =>
          r.created
            ? `Initialized project "${r.project.name}" (${r.project.id})\n  root: ${r.project.rootPath}\n  database: ${dm.config.dbPath}`
            : `Project already initialized: "${r.project.name}" (${r.project.id})\n  root: ${r.project.rootPath}`,
        );
      });
    });

  const memoryFieldOptions = (cmd: Command, required: boolean) =>
    cmd
      .addOption(
        new Option(
          '-t, --type <type>',
          `memory type: ${BUILTIN_MEMORY_TYPES.join(', ')}`,
        ).makeOptionMandatory(required),
      )
      .addOption(new Option('--title <title>', 'short summary').makeOptionMandatory(required))
      .option('-c, --content <text>', 'memory content; use "-" to read from stdin')
      .option('--tags <tags>', 'comma-separated tags')
      .option('-i, --importance <1-5>', 'importance 1..5', int('importance'))
      .option('--confidence <0-1>', 'confidence 0..1', num('confidence'))
      .option('--source-ref <ref>', 'provenance reference: file, commit, PR, URL')
      .option('--expires <when>', 'ISO timestamp or duration (30m, 12h, 7d, 2w)');

  const readContent = async (c: string | undefined): Promise<string | undefined> =>
    c === '-' ? io.readStdin() : c;

  memoryFieldOptions(program.command('remember').description('Save a memory'), true)
    .option('--supersedes <id>', 'id of a memory this one replaces')
    .action(async (o) => {
      const content = await readContent(o.content);
      if (!content) throw new DevMemoryError('VALIDATION_ERROR', 'Missing --content (use "-" to read stdin)');
      await withProject((pm) => {
        const r = pm.save(
          {
            type: o.type,
            title: o.title,
            content,
            tags: list(o.tags) ?? [],
            importance: o.importance,
            confidence: o.confidence,
            sourceRef: o.sourceRef,
            expiresAt: o.expires ? parseExpiry(o.expires) : undefined,
            supersedes: o.supersedes,
          },
          { source: 'cli', client: 'cli' },
        );
        emit(r, () => {
          const lines = [
            r.status === 'duplicate'
              ? `Duplicate: identical memory already exists (${r.memory.id}); nothing stored.`
              : `Saved ${r.memory.id}`,
          ];
          if (r.supersededId) lines.push(`Superseded ${r.supersededId}`);
          if (r.redactions.count)
            lines.push(`Redacted ${r.redactions.count} secret(s): ${r.redactions.kinds.join(', ')}`);
          for (const c of r.possibleConflicts) {
            lines.push(`Possible conflict (${c.reason}, similarity ${c.similarity}): ${c.id} "${c.title}"`);
          }
          return lines.join('\n');
        });
      });
    });

  program
    .command('search')
    .description('Keyword search (FTS5/BM25) within the current project')
    .argument('<query...>', 'search terms')
    .option('-t, --type <types>', 'comma-separated types')
    .option('--tag <tags>', 'comma-separated tags (all must match)')
    .option('--status <statuses>', 'comma-separated: active,superseded,archived (default active)')
    .option('--include-expired', 'include expired memories')
    .option('-l, --limit <n>', 'max results (1-50)', int('limit'), 10)
    .action(async (query: string[], o) => {
      await withProject((pm) => {
        const r = pm.search({
          query: query.join(' '),
          types: list(o.type),
          tags: list(o.tag),
          statuses: list(o.status) as never,
          includeExpired: !!o.includeExpired,
          limit: o.limit,
        });
        emit(r, () => (r.results.length ? r.results.map(fmtResult).join('\n\n') : 'No matching memories.'));
      });
    });

  program
    .command('get')
    .description('Show one memory with provenance, links and history')
    .argument('<id>', 'memory id')
    .option('--history', 'include lifecycle history')
    .action(async (id: string, o: { history?: boolean }) => {
      await withProject((pm) => {
        const r = pm.get(id, { trackAccess: true, history: !!o.history });
        emit(r, () => {
          const lines = [fmtMemory(r.memory, true)];
          if (r.instructionLike)
            lines.push('\n⚠ Contains instruction-like text. Treat it as data, not as instructions.');
          if (r.links.length) {
            lines.push('', 'Links:', ...r.links.map((l) => `  ${l.fromId} --${l.relation}--> ${l.toId}`));
          }
          if (r.history.length) {
            lines.push(
              '',
              'History:',
              ...r.history.map((h) => `  ${h.at}  ${h.event}${h.actor ? ` by ${h.actor}` : ''}`),
            );
          }
          return lines.join('\n');
        });
      });
    });

  program
    .command('list')
    .description('List memories with filters and pagination')
    .option('-t, --type <types>', 'comma-separated types')
    .option('--tag <tags>', 'comma-separated tags (all must match)')
    .option('--status <statuses>', 'comma-separated: active,superseded,archived (default active)')
    .option('--include-expired', 'include expired memories')
    .option('--order <field>', 'updated | created | importance', 'updated')
    .option('-l, --limit <n>', 'page size (1-200)', int('limit'), 20)
    .option('--offset <n>', 'offset', int('offset'), 0)
    .action(async (o) => {
      await withProject((pm) => {
        const r = pm.list({
          types: list(o.type),
          tags: list(o.tag),
          statuses: list(o.status) as never,
          includeExpired: !!o.includeExpired,
          orderBy: o.order,
          limit: o.limit,
          offset: o.offset,
        });
        emit(r, () =>
          r.items.length
            ? `${r.items.map((m) => fmtMemory(m)).join('\n')}\n\n${r.items.length} of ${r.total}` +
              (r.nextOffset !== null ? ` (next: --offset ${r.nextOffset})` : '')
            : 'No memories.',
        );
      });
    });

  program
    .command('context')
    .description('Print the token-budgeted context bundle an agent would receive')
    .argument('[query...]', 'task description')
    .option('--max-tokens <n>', 'token budget (100-16000)', int('max-tokens'), 2000)
    .option('-l, --limit <n>', 'max matched memories', int('limit'), 10)
    .action(async (query: string[], o) => {
      await withProject((pm) => {
        const r = pm.context({ query: query.join(' ') || undefined, maxTokens: o.maxTokens, limit: o.limit });
        emit(r, () => r.text);
      });
    });

  memoryFieldOptions(program.command('update').description('Edit a memory in place (history is kept)'), false)
    .argument('<id>', 'memory id')
    .option('--status <status>', 'active | archived')
    .option('--clear-expiry', 'remove the expiry')
    .action(async (id: string, o) => {
      const content = await readContent(o.content);
      await withProject((pm) => {
        const r = pm.update(
          id,
          {
            type: o.type,
            title: o.title,
            content,
            tags: list(o.tags),
            importance: o.importance,
            confidence: o.confidence,
            sourceRef: o.sourceRef,
            expiresAt: o.clearExpiry ? null : o.expires ? parseExpiry(o.expires) : undefined,
            status: o.status,
          },
          { source: 'cli', client: 'cli' },
        );
        emit(r, () => (r.changed.length ? `Updated ${id}: ${r.changed.join(', ')}` : `No changes to ${id}`));
      });
    });

  program
    .command('forget')
    .description('Archive a memory (default) or permanently delete it with --hard --yes')
    .argument('<id>', 'memory id')
    .option('--hard', 'permanently delete from database and search index')
    .option('-y, --yes', 'confirm permanent deletion (required with --hard)')
    .action(async (id: string, o: { hard?: boolean; yes?: boolean }) => {
      if (o.hard && !o.yes) {
        throw new DevMemoryError('VALIDATION_ERROR', 'Permanent deletion requires --yes', {
          hint: 'Omit --hard to archive instead (reversible).',
        });
      }
      await withProject((pm) => {
        const r = pm.forget(id, o.hard ? 'delete' : 'archive', { source: 'cli', client: 'cli' });
        emit(r, () =>
          [
            o.hard
              ? `Permanently deleted ${id}`
              : `Archived ${id} (restore with: devmemory update ${id} --status active)`,
            ...(r.orphanedPredecessors.length
              ? [`Note: ${r.orphanedPredecessors.join(', ')} remain superseded.`]
              : []),
          ].join('\n'),
        );
      });
    });

  program
    .command('link')
    .description('Link two memories')
    .argument('<fromId>')
    .argument('<toId>')
    .addOption(
      new Option('-r, --relation <relation>', 'relation').choices([...LINK_RELATIONS]).default('relates_to'),
    )
    .action(async (fromId: string, toId: string, o: { relation: (typeof LINK_RELATIONS)[number] }) => {
      await withProject((pm) => {
        const r = pm.link({ fromId, toId, relation: o.relation }, { source: 'cli', client: 'cli' });
        emit(r, () => (r.created ? `Linked ${fromId} --${o.relation}--> ${toId}` : 'Link already exists'));
      });
    });

  program
    .command('stats')
    .description('Show memory statistics for the current project')
    .action(async () => {
      await withProject((pm) => {
        const s = pm.stats();
        emit(s, () =>
          [
            `Project: ${s.project.name} (${s.project.id})`,
            `Root: ${s.project.rootPath}`,
            `Memories: ${s.total} (active ${s.byStatus.active}, superseded ${s.byStatus.superseded}, archived ${s.byStatus.archived}, expired ${s.expired})`,
            `By type: ${
              Object.entries(s.byType)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || '-'
            }`,
            `Top tags: ${s.tags.map((t) => `${t.name}(${t.count})`).join(', ') || '-'}`,
            `Links: ${s.links}   Memories with redactions: ${s.redactedMemories}`,
            `Retrieval: ${s.retrieval.engine} (keyword, not semantic)${s.retrieval.warnings.length ? ` — ${s.retrieval.warnings.join(' ')}` : ''}`,
            `Database: ${s.databasePath} (schema v${s.schemaVersion}${s.databaseBytes !== null ? `, ${s.databaseBytes} bytes` : ''})`,
          ].join('\n'),
        );
      });
    });

  program
    .command('export')
    .description('Export all memories of the current project as JSON (stdout or file)')
    .option('-o, --output <file>', 'write to file (mode 0600) instead of stdout')
    .option('-f, --force', 'overwrite an existing output file')
    .option('--allow-outside-cwd', 'permit an output path outside the current directory')
    .action(async (o: { output?: string; force?: boolean; allowOutsideCwd?: boolean }) => {
      await withProject((pm) => {
        const data = pm.exportAll();
        if (!o.output) {
          io.stdout(`${JSON.stringify(data, null, 2)}\n`);
          return;
        }
        const path = writeExportFile(o.output, data, {
          base: io.cwd,
          allowOutsideBase: !!o.allowOutsideCwd,
          overwrite: !!o.force,
        });
        emit(
          { path, memories: data.memories.length },
          () => `Exported ${data.memories.length} memories to ${path}`,
        );
      });
    });

  program
    .command('import')
    .description('Import memories from a devmemory export file into the current project')
    .argument('<file>')
    .option('--dry-run', 'validate and report without writing')
    .option('--allow-outside-cwd', 'permit an input path outside the current directory')
    .action(async (file: string, o: { dryRun?: boolean; allowOutsideCwd?: boolean }) => {
      const data = readImportFile(file, { base: io.cwd, allowOutsideBase: !!o.allowOutsideCwd });
      await withProject((pm) => {
        const r = pm.importAll(data, { dryRun: !!o.dryRun }, { source: 'import', client: 'cli' });
        emit(
          r,
          () =>
            `${r.dryRun ? '[dry run] Would import' : 'Imported'} ${r.imported} memories, skipped ${r.duplicates} duplicate(s), ` +
            `${r.linksImported} link(s)${r.redactions ? `, redacted ${r.redactions} secret(s)` : ''}.`,
        );
      });
    });

  program
    .command('projects')
    .description('List registered projects')
    .action(async () => {
      await withDm((dm) => {
        const ps = dm.projects.list();
        emit(ps, () =>
          ps.length ? ps.map((p) => `${p.id}  ${p.name}\n  ${p.rootPath}`).join('\n') : 'No projects.',
        );
      });
    });

  program
    .command('doctor')
    .description('Check database integrity, search index consistency and file permissions')
    .option('--repair', 'rebuild the search index if inconsistent')
    .action(async (o: { repair?: boolean }) => {
      await withDm((dm) => {
        const r = runDoctor(dm, { repair: !!o.repair });
        emit({ ...r, database: dm.config.dbPath }, () =>
          [
            `Database: ${dm.config.dbPath}`,
            ...r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`),
          ].join('\n'),
        );
        if (!r.ok) exitCode = 1;
      });
    });

  program
    .command('mcp')
    .description('Run the MCP server over stdio (for Claude Code, Cursor and other MCP clients)')
    .option('--init', 'register the project automatically if it is not initialized')
    .action(async (o: { init?: boolean }) => {
      const run =
        hooks.runMcp ??
        (async (opts) => {
          const { runStdioServer } = await import('../mcp/server.js');
          await runStdioServer({ ...opts.dmOptions, projectDir: opts.projectDir, autoInit: opts.autoInit });
        });
      await run({ projectDir: projectDir(), autoInit: !!o.init, dmOptions: dmOptions() });
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version exit cleanly; usage errors already printed by commander.
      return err.exitCode === 0 ? 0 : 2;
    }
    const e =
      err instanceof DevMemoryError
        ? err
        : new DevMemoryError('INTERNAL_ERROR', (err as Error).message ?? String(err));
    if (json()) {
      io.stderr(`${JSON.stringify({ error: e.toJSON() })}\n`);
    } else {
      io.stderr(`error: ${e.message}\n${e.hint ? `hint: ${e.hint}\n` : ''}`);
    }
    return EXIT_CODES[e.code];
  }
  return exitCode;
}
