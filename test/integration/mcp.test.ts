import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_PATH, cliEnv, setupEnv, tempDir } from '../helpers.js';

type Structured = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const clients: Client[] = [];
afterEach(async () => {
  while (clients.length)
    await clients
      .pop()!
      .close()
      .catch(() => undefined);
});

async function connect(home: string, projectDir: string, extraArgs: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, 'mcp', '--project', projectDir, ...extraArgs],
    env: cliEnv(home) as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'devmemory-test-client', version: '9.9.9' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return {
    isError: !!r.isError,
    data: r.structuredContent as Structured,
    text: (r.content as { text: string }[])[0]?.text ?? '',
  };
}

function setupProjects() {
  const env = setupEnv();
  const { dir: projectA, dm } = env.project('alpha');
  const { dir: projectB } = env.project('beta', dm);
  dm.close();
  return { env, projectA, projectB };
}

describe('MCP server over stdio (real transport, built binary)', () => {
  it('exposes exactly the nine documented tools with input and output schemas', async () => {
    const { env, projectA } = setupProjects();
    const client = await connect(env.home, projectA);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'memory_context',
      'memory_forget',
      'memory_get',
      'memory_link',
      'memory_list',
      'memory_save',
      'memory_search',
      'memory_stats',
      'memory_update',
    ]);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type, t.name).toBe('object');
    }
    expect(client.getServerVersion()?.name).toBe('devmemory');
    expect(client.getInstructions()).toMatch(/untrusted/);
  });

  it('round-trips every tool', async () => {
    const { env, projectA } = setupProjects();
    const c = await connect(env.home, projectA);

    const saved = await call(c, 'memory_save', {
      type: 'decision',
      title: 'Use Drizzle ORM',
      content: 'We use Drizzle ORM for type-safe SQL; Prisma was too heavy for edge functions.',
      tags: ['db', 'orm'],
      importance: 4,
      sourceRef: 'docs/adr/0012.md',
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.status).toBe('created');
    const id = saved.data.memory.id as string;
    expect(saved.data.memory.provenance).toMatchObject({
      source: 'mcp',
      client: 'devmemory-test-client/9.9.9',
      sourceRef: 'docs/adr/0012.md',
    });

    const dup = await call(c, 'memory_save', {
      type: 'decision',
      title: 'Use Drizzle ORM',
      content: 'We use Drizzle ORM for type-safe SQL; Prisma was too heavy for edge functions.',
    });
    expect(dup.data).toMatchObject({ status: 'duplicate', memory: { id } });
    expect(dup.text).toMatch(/Duplicate/);

    const search = await call(c, 'memory_search', { query: 'which ORM do we use' });
    expect(search.data.results[0].memory.id).toBe(id);
    expect(search.data.retrieval).toMatchObject({ mode: 'keyword', semantic: false });

    const got = await call(c, 'memory_get', { id, includeHistory: true });
    expect(got.data.memory.title).toBe('Use Drizzle ORM');
    expect(got.data.history[0].event).toBe('created');

    const other = await call(c, 'memory_save', {
      type: 'constraint',
      title: 'Edge runtime',
      content: 'API handlers run on the edge runtime.',
      importance: 5,
    });
    const linked = await call(c, 'memory_link', {
      fromId: id,
      toId: other.data.memory.id,
      relation: 'depends_on',
    });
    expect(linked.data.created).toBe(true);

    const updated = await call(c, 'memory_update', { id, tags: ['db', 'orm', 'drizzle'] });
    expect(updated.data.changed).toEqual(['tags']);

    const list = await call(c, 'memory_list', { orderBy: 'importance' });
    expect(list.data.total).toBe(2);
    expect(list.data.items[0].type).toBe('constraint');

    const ctx = await call(c, 'memory_context', { query: 'database access layer ORM', maxTokens: 800 });
    expect(ctx.data.items.map((i: Structured) => i.id)).toEqual(
      expect.arrayContaining([id, other.data.memory.id]),
    );
    expect(ctx.text).toContain('UNTRUSTED REFERENCE DATA');
    expect(ctx.data.usedTokens).toBeLessThanOrEqual(800);

    const stats = await call(c, 'memory_stats', {});
    expect(stats.data).toMatchObject({ total: 2, links: 1, project: { name: 'alpha' } });

    const archived = await call(c, 'memory_forget', { id: other.data.memory.id });
    expect(archived.data.mode).toBe('archive');
    const refused = await call(c, 'memory_forget', { id, mode: 'delete' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/confirm=true/);
    const deleted = await call(c, 'memory_forget', { id, mode: 'delete', confirm: true });
    expect(deleted.data.mode).toBe('delete');
    expect((await call(c, 'memory_get', { id })).isError).toBe(true);
  });

  it('returns structured errors for malformed inputs without crashing', async () => {
    const { env, projectA } = setupProjects();
    const c = await connect(env.home, projectA);
    const cases: [string, Record<string, unknown>][] = [
      ['memory_save', { type: 'decision', title: 'x' }],
      ['memory_save', { type: 'nonsense', title: 'x', content: 'y' }],
      ['memory_save', { type: 'fact', title: 'x', content: 'y', importance: 42 }],
      ['memory_save', { type: 'fact', title: 'x', content: 'y', expiresAt: 'next tuesday' }],
      ['memory_search', { query: '' }],
      ['memory_search', { query: 'x', limit: 5000 }],
      ['memory_get', { id: '../../etc/passwd' }],
      ['memory_get', { id: 'mem_doesnotexist0000' }],
      ['memory_update', { id: 'mem_doesnotexist0000' }],
      ['memory_link', { fromId: 'mem_aaaaaaaaaaaa', toId: 'mem_aaaaaaaaaaaa' }],
      ['memory_context', { maxTokens: 10 }],
    ];
    for (const [name, args] of cases) {
      const r = await call(c, name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    const unknownType = await call(c, 'memory_save', { type: 'nonsense', title: 'x', content: 'y' });
    expect(JSON.parse(unknownType.text).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      hint: expect.stringMatching(/Allowed/),
    });
    // Server is still healthy.
    expect((await call(c, 'memory_stats', {})).isError).toBe(false);
  });

  it('redacts secrets before persistence and in responses', async () => {
    const { env, projectA } = setupProjects();
    const c = await connect(env.home, projectA);
    const secret = 'sk_live_' + 'Q'.repeat(28);
    const r = await call(c, 'memory_save', {
      type: 'fact',
      title: 'Payments',
      content: `Stripe key is ${secret}`,
    });
    expect(r.data.redactions.count).toBe(1);
    expect(r.text).not.toContain(secret);
    const s = await call(c, 'memory_search', { query: 'stripe payments' });
    expect(JSON.stringify(s)).not.toContain(secret);
  });

  it('persists across MCP process restarts (fresh session retrieves without resubmitting)', async () => {
    const { env, projectA } = setupProjects();
    const first = await connect(env.home, projectA);
    const saved = await call(first, 'memory_save', {
      type: 'decision',
      title: 'Feature flags via OpenFeature',
      content: 'All feature flags go through the OpenFeature SDK with the flagd provider.',
    });
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await connect(env.home, projectA);
    const ctx = await call(second, 'memory_context', { query: 'how are feature flags implemented' });
    expect(ctx.data.items[0]).toMatchObject({
      id: saved.data.memory.id,
      provenance: { source: 'mcp', client: 'devmemory-test-client/9.9.9' },
    });
    expect(ctx.text).toContain('OpenFeature');
  });

  it('isolates projects: a server bound to project B cannot see project A', async () => {
    const { env, projectA, projectB } = setupProjects();
    const a = await connect(env.home, projectA);
    const saved = await call(a, 'memory_save', {
      type: 'fact',
      title: 'Alpha secret codename',
      content: 'Codename is BLUEHERON.',
    });
    const b = await connect(env.home, projectB);
    expect(
      (
        await call(b, 'memory_search', {
          query: 'BLUEHERON codename',
          statuses: ['active', 'archived', 'superseded'],
          includeExpired: true,
        })
      ).data.results,
    ).toEqual([]);
    expect((await call(b, 'memory_context', { query: 'BLUEHERON' })).data.items).toEqual([]);
    const get = await call(b, 'memory_get', { id: saved.data.memory.id });
    expect(get.isError).toBe(true);
    expect(JSON.parse(get.text).error.code).toBe('NOT_FOUND');
    expect(
      (await call(b, 'memory_forget', { id: saved.data.memory.id, mode: 'delete', confirm: true })).isError,
    ).toBe(true);
    expect((await call(a, 'memory_get', { id: saved.data.memory.id })).isError).toBe(false);
  });

  it('reports PROJECT_NOT_INITIALIZED for unregistered dirs and auto-registers with --init', async () => {
    const env = setupEnv();
    const dir = join(tempDir(), 'fresh');
    mkdirSync(dir);
    const c = await connect(env.home, dir);
    const r = await call(c, 'memory_stats', {});
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).error).toMatchObject({
      code: 'PROJECT_NOT_INITIALIZED',
      hint: expect.stringMatching(/devmemory init/),
    });
    const c2 = await connect(env.home, dir, ['--init']);
    expect((await call(c2, 'memory_stats', {})).data.total).toBe(0);
  });

  it('handles concurrent tool calls on one connection', async () => {
    const { env, projectA } = setupProjects();
    const c = await connect(env.home, projectA);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        call(c, 'memory_save', {
          type: 'fact',
          title: `parallel ${i}`,
          content: `parallel write number ${i}`,
        }),
      ),
    );
    expect(results.every((r) => !r.isError && r.data.status === 'created')).toBe(true);
    expect((await call(c, 'memory_stats', {})).data.total).toBe(25);
  });

  it('shuts down cleanly when the client disconnects', async () => {
    const { env, projectA } = setupProjects();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'mcp', '--project', projectA],
      env: cliEnv(env.home) as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport);
    const pid = transport.pid!;
    await client.close();
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
