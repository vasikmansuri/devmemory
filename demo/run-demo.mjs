#!/usr/bin/env node
// Repeatable end-to-end demo using the real built CLI and real MCP stdio processes.
// Nothing here is simulated: every line printed comes from an actual process response.
//
//   npm run demo
//
// It uses a throwaway DEVMEMORY_HOME so your real ~/.devmemory is never touched.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'devmemory-demo-')));
const home = join(root, 'home');
const projectA = join(root, 'acme-api');
const projectB = join(root, 'other-app');
mkdirSync(projectA);
mkdirSync(projectB);
const env = { ...process.env, DEVMEMORY_HOME: home, DEVMEMORY_LOG_LEVEL: 'error' };

const step = (n, text) => console.log(`\n\x1b[1m[${n}] ${text}\x1b[0m`);
const cli = (cwd, ...args) => {
  console.log(`$ devmemory ${args.join(' ')}`);
  const out = execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  console.log(out.trimEnd());
  return out;
};

async function connect(projectDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--project', projectDir],
    env,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'devmemory-demo', version: '1.0.0' });
  await client.connect(transport);
  console.log(`(started MCP server process pid=${transport.pid} for ${label})`);
  return { client, transport };
}

async function tool(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`→ ${name}(${JSON.stringify(args)})`);
  return r;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  step(1, 'Initialize two projects');
  cli(projectA, 'init', '--name', 'acme-api');
  cli(projectB, 'init', '--name', 'other-app');

  step(2, 'Session 1: save a technical decision over MCP');
  const s1 = await connect(projectA, 'acme-api');
  const saved = await tool(s1.client, 'memory_save', {
    type: 'decision',
    title: 'Use idempotency keys for all payment endpoints',
    content:
      'POST /payments and /refunds require an Idempotency-Key header. Keys are stored for 24h in Postgres ' +
      '(table idempotency_keys) so client retries never double-charge. Chosen over request de-duplication in Redis ' +
      'because Redis eviction could drop keys.',
    tags: ['payments', 'api'],
    importance: 5,
    sourceRef: 'docs/adr/0007-idempotency.md',
  });
  const id = saved.structuredContent.memory.id;
  console.log(`  status=${saved.structuredContent.status} id=${id}`);

  step(3, 'Confirm the memory exists');
  const got = await tool(s1.client, 'memory_get', { id });
  console.log(
    `  title="${got.structuredContent.memory.title}" status=${got.structuredContent.memory.status}`,
  );

  step(4, 'Shut down the MCP process');
  const pid1 = s1.transport.pid;
  await s1.client.close();
  for (let i = 0; i < 100 && processAlive(pid1); i++) await new Promise((r) => setTimeout(r, 50));
  console.log(`  pid ${pid1} alive after close: ${processAlive(pid1)}`);

  step(5, 'Session 2: brand-new MCP process, nothing resubmitted');
  const s2 = await connect(projectA, 'acme-api');
  console.log(`  new pid=${s2.transport.pid} (previous pid=${pid1})`);

  step(6, 'Retrieve the decision by asking about the task');
  const ctx = await tool(s2.client, 'memory_context', {
    query: 'how do we avoid charging a customer twice on retry',
  });
  const item = ctx.structuredContent.items[0];
  console.log(`  top item: ${item.id} "${item.title}" (reason=${item.reason}, score=${item.score})`);
  console.log(`  same id as saved in session 1: ${item.id === id}`);

  step(7, 'Provenance of the returned memory');
  console.log(JSON.stringify(item.provenance, null, 2).replace(/^/gm, '  '));
  console.log('\n  Context text handed to the agent (excerpt):');
  console.log(ctx.content[0].text.split('\n').slice(0, 6).join('\n').replace(/^/gm, '  | '));
  await s2.client.close();

  step(8, 'Isolation: a server bound to other-app cannot retrieve acme-api memory');
  const s3 = await connect(projectB, 'other-app');
  const search = await tool(s3.client, 'memory_search', {
    query: 'idempotency payments charging twice',
    statuses: ['active', 'archived', 'superseded'],
    includeExpired: true,
  });
  console.log(`  results: ${search.structuredContent.results.length}`);
  const direct = await tool(s3.client, 'memory_get', { id });
  console.log(`  memory_get by id: isError=${direct.isError} ${direct.content[0].text}`);
  await s3.client.close();

  step(9, 'Same checks from the CLI');
  cli(projectA, 'search', 'idempotency');
  cli(projectB, 'search', 'idempotency');

  const ok =
    item.id === id &&
    !processAlive(pid1) &&
    search.structuredContent.results.length === 0 &&
    direct.isError === true;
  console.log(`\nDEMO ${ok ? 'PASSED' : 'FAILED'}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
