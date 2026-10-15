/**
 * DevMemory library entry point. The memory engine is usable without MCP:
 *
 *   const dm = DevMemory.open();
 *   const pm = dm.project(dm.projects.init(process.cwd()).project);
 *   pm.save({ type: 'decision', title: '...', content: '...' });
 */
export { DevMemory, ProjectMemory, parseInput } from './core/engine.js';
export type {
  ContextBundle,
  DevMemoryOptions,
  ForgetResult,
  ImportResult,
  ListResult,
  MemoryDetails,
  ProjectStats,
  RetrievalInfo,
  SaveResult,
  ScoreBreakdown,
  SearchResponse,
  SearchResult,
  SimilarMemory,
} from './core/engine.js';
export { DevMemoryError, EXIT_CODES, type ErrorCode } from './core/errors.js';
export * from './core/types.js';
export { ProjectRegistry } from './core/projects.js';
export { loadConfig, type DevMemoryConfig } from './config.js';
export { redactSecrets, containsSecret, SECRET_PATTERNS } from './security/secrets.js';
export { detectInstructionLikeContent, UNTRUSTED_PREAMBLE } from './security/injection.js';
export { resolveSafePath } from './security/paths.js';
export { registerEmbeddingProvider, type EmbeddingProvider } from './search/embeddings.js';
export type { Retriever, RetrievalFilters, RetrievalHit } from './search/retriever.js';
export {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  parseExportFile,
  readImportFile,
  writeExportFile,
} from './io/transfer.js';
export { createDevMemoryMcpServer } from './mcp/tools.js';
export { runStdioServer } from './mcp/server.js';
export { runDoctor } from './diagnostics.js';
export { VERSION } from './version.js';
