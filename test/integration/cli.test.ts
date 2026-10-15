import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_PATH, cliEnv, tempDir } from '../helpers.js';

function cli(home: string, cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: cliEnv(home),
    input,
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function workspace() {
  const home = tempDir('dm-cli-home-');
  const proj = join(tempDir('dm-cli-ws-'), 'webapp');
  mkdirSync(proj);
  return { home, proj };
}

describe('CLI (built binary)', () => {
  it('prints help and version', () => {
    const { home, proj } = workspace();
    const help = cli(home, proj, ['--help']);
    expect(help.code).toBe(0);
    for (const cmd of [
      'init',
      'remember',
      'search',
      'get',
      'list',
      'stats',
      'export',
      'import',
      'forget',
      'mcp',
      'context',
      'doctor',
    ]) {
      expect(help.stdout).toContain(cmd);
    }
    const version = cli(home, proj, ['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli(home, proj, ['remember', '--help']).stdout).toContain('--supersedes');
  });

  it('runs a full workflow with JSON output and meaningful exit codes', () => {
    const { home, proj } = workspace();
    expect(cli(home, proj, ['search', 'x']).code).toBe(4); // not initialised
    expect(cli(home, proj, ['search', 'x']).stderr).toMatch(/hint: Run `devmemory init`/);

    const init = cli(home, proj, ['--json', 'init', '--name', 'Web App']);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ created: true, project: { name: 'Web App' } });

    const saved = cli(home, proj, [
      '--json',
      'remember',
      '-t',
      'decision',
      '--title',
      'Use Tailwind',
      '-c',
      'Styling uses Tailwind CSS v4.',
      '--tags',
      'css,ui',
      '-i',
      '4',
      '--source-ref',
      'PR #7',
    ]);
    expect(saved.code).toBe(0);
    const id = JSON.parse(saved.stdout).memory.id as string;

    const search = cli(home, proj, ['--json', 'search', 'tailwind', 'styling']);
    expect(JSON.parse(search.stdout).results[0].memory.id).toBe(id);
    expect(cli(home, proj, ['search', 'tailwind']).stdout).toContain(id);

    const get = cli(home, proj, ['get', id, '--history']);
    expect(get.stdout).toContain('provenance: source=cli client=cli ref=PR #7');
    expect(get.stdout).toContain('created by cli:cli');

    expect(JSON.parse(cli(home, proj, ['--json', 'list']).stdout).total).toBe(1);
    expect(JSON.parse(cli(home, proj, ['--json', 'stats']).stdout).byType).toEqual({ decision: 1 });
    expect(cli(home, proj, ['context', 'css', 'styling']).stdout).toContain('<devmemory-context');

    // Works from a subdirectory of the project.
    const sub = join(proj, 'src', 'components');
    mkdirSync(sub, { recursive: true });
    expect(JSON.parse(cli(home, sub, ['--json', 'search', 'tailwind']).stdout).results).toHaveLength(1);

    // Validation and not-found exit codes.
    expect(cli(home, proj, ['remember', '-t', 'bogus', '--title', 'x', '-c', 'y']).code).toBe(2);
    expect(cli(home, proj, ['remember', '-t', 'fact', '--title', 'x']).code).toBe(2);
    expect(cli(home, proj, ['get', 'mem_nope00000000000']).code).toBe(3);
    expect(cli(home, proj, ['nosuchcommand']).code).toBe(2);

    // Forget: archive by default, hard delete needs --yes.
    expect(cli(home, proj, ['forget', id, '--hard']).code).toBe(2);
    expect(cli(home, proj, ['forget', id]).stdout).toContain('Archived');
    expect(JSON.parse(cli(home, proj, ['--json', 'search', 'tailwind']).stdout).results).toHaveLength(0);
    expect(cli(home, proj, ['forget', id, '--hard', '--yes']).code).toBe(0);
    expect(cli(home, proj, ['get', id]).code).toBe(3);
  });

  it('reads content from stdin with --content -', () => {
    const { home, proj } = workspace();
    cli(home, proj, ['init']);
    const r = cli(
      home,
      proj,
      ['--json', 'remember', '-t', 'debugging', '--title', 'Segfault in sharp', '-c', '-'],
      'sharp crashed on Alpine;\nuse the glibc image.\n',
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).memory.content).toBe('sharp crashed on Alpine;\nuse the glibc image.');
  });

  it('supersedes, updates and links from the CLI', () => {
    const { home, proj } = workspace();
    cli(home, proj, ['init']);
    const a = JSON.parse(
      cli(home, proj, ['--json', 'remember', '-t', 'decision', '--title', 'Node 20', '-c', 'Target Node 20.'])
        .stdout,
    ).memory.id;
    const b = JSON.parse(
      cli(home, proj, [
        '--json',
        'remember',
        '-t',
        'decision',
        '--title',
        'Node 22',
        '-c',
        'Target Node 22 LTS.',
        '--supersedes',
        a,
      ]).stdout,
    );
    expect(b.supersededId).toBe(a);
    const u = JSON.parse(
      cli(home, proj, ['--json', 'update', b.memory.id, '-i', '5', '--expires', '30d']).stdout,
    );
    expect(u.changed.sort()).toEqual(['expires_at', 'importance']);
    const c = JSON.parse(
      cli(home, proj, [
        '--json',
        'remember',
        '-t',
        'fact',
        '--title',
        'CI image',
        '-c',
        'CI uses node:22-slim',
      ]).stdout,
    ).memory.id;
    expect(cli(home, proj, ['link', c, b.memory.id, '-r', 'depends_on']).stdout).toContain('depends_on');
    expect(cli(home, proj, ['link', c, b.memory.id, '-r', 'bogus']).code).toBe(2);
  });

  it('exports to a 0600 file and imports into a second project, with path safety', () => {
    const { home, proj } = workspace();
    cli(home, proj, ['init']);
    cli(home, proj, [
      'remember',
      '-t',
      'convention',
      '--title',
      'Conventional commits',
      '-c',
      'Use feat:/fix: prefixes.',
    ]);
    const exp = cli(home, proj, ['export', '-o', 'memories.json']);
    expect(exp.code).toBe(0);
    const file = join(proj, 'memories.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(cli(home, proj, ['export', '-o', 'memories.json']).code).toBe(5); // exists, no --force
    expect(cli(home, proj, ['export', '-o', '../escape.json']).code).toBe(7);
    expect(existsSync(join(proj, '..', 'escape.json'))).toBe(false);
    expect(JSON.parse(cli(home, proj, ['export']).stdout).memories).toHaveLength(1);

    const other = join(proj, '..', 'other');
    mkdirSync(other);
    cli(home, other, ['init']);
    const dry = cli(home, other, [
      '--json',
      'import',
      '../webapp/memories.json',
      '--allow-outside-cwd',
      '--dry-run',
    ]);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, imported: 1 });
    expect(cli(home, other, ['import', '../webapp/memories.json']).code).toBe(7); // outside cwd without opt-in
    const imp = cli(home, other, ['import', '../webapp/memories.json', '--allow-outside-cwd']);
    expect(imp.stdout).toContain('Imported 1 memories');
    expect(cli(home, other, ['search', 'conventional']).stdout).toContain('Conventional commits');
    expect(readFileSync(file, 'utf8')).toContain('devmemory-export');
  });

  it('rejects malformed import files with exit code 2', () => {
    const { home, proj } = workspace();
    cli(home, proj, ['init']);
    writeFileSync(
      join(proj, 'bad.json'),
      '{"format":"devmemory-export","version":1,"memories":[{"id":"a"}]}',
    );
    const r = cli(home, proj, ['import', 'bad.json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Invalid import file/);
  });

  it('doctor and projects commands work', () => {
    const { home, proj } = workspace();
    cli(home, proj, ['init']);
    const doc = cli(home, proj, ['--json', 'doctor']);
    expect(doc.code).toBe(0);
    expect(JSON.parse(doc.stdout).ok).toBe(true);
    expect(cli(home, proj, ['projects']).stdout).toContain('webapp');
  });

  it('JSON-mode errors are machine readable on stderr', () => {
    const { home, proj } = workspace();
    const r = cli(home, proj, ['--json', 'stats']);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stderr).error.code).toBe('PROJECT_NOT_INITIALIZED');
    expect(r.stdout).toBe('');
  });
});
