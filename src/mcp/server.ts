import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DevMemory, type DevMemoryOptions } from '../core/engine.js';
import { createDevMemoryMcpServer } from './tools.js';

export interface StdioServerOptions extends DevMemoryOptions {
  projectDir: string;
  autoInit?: boolean;
}

/**
 * Run the DevMemory MCP server over stdio. No network listener is opened.
 * Resolves when the client disconnects (stdin closes) or a termination signal arrives.
 */
export async function runStdioServer(opts: StdioServerOptions): Promise<void> {
  const dm = DevMemory.open(opts);
  dm.logger.info('devmemory mcp server starting', {
    projectDir: opts.projectDir,
    retrieval: dm.retrieval.engine,
  });

  let shuttingDown = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const handle = serveStdio(
    () => createDevMemoryMcpServer({ dm, projectDir: opts.projectDir, autoInit: opts.autoInit ?? false }),
    {
      onerror: (err) => dm.logger.warn('transport error', { error: err.message }),
    },
  );

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    dm.logger.info('devmemory mcp server stopping', { reason });
    try {
      await handle.close();
    } catch {
      // already closed
    }
    dm.close();
    resolveDone();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.once('end', () => void shutdown('stdin closed'));
  process.stdin.once('close', () => void shutdown('stdin closed'));
  await done;
}
