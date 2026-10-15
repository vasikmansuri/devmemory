# Architecture

```
MCP client ──stdio──▶ src/mcp (tools.ts, server.ts) ─┐
CLI ────────────────▶ src/cli (program.ts)          ─┼─▶ src/core/engine.ts (DevMemory / ProjectMemory)
Library users ──────────────────────────────────────┘        │
                                                             ├─ src/security   (redaction, injection flags, safe paths)
                                                             ├─ src/search     (query parsing, FTS5/LIKE retrievers, embeddings hook)
                                                             ├─ src/io         (export/import format + file IO)
                                                             ├─ src/core/context.ts (token-budgeted bundles)
                                                             └─ src/db         (connection, pragmas, migrations)
                                                                     ▼
                                                        ~/.devmemory/devmemory.db
```

- **One engine.** The CLI and the MCP server call the same `ProjectMemory` methods. The engine has no MCP dependency, so it can be used on its own.
- **Project scoping.** `DevMemory.project(p)` returns a handle, and every query that handle runs includes `project_id = ?`. Looking up an id that belongs to another project returns the same `NOT_FOUND` error as an unknown id.
- **Transactions.** All writes run in `BEGIN IMMEDIATE` transactions. Cross-process concurrency relies on WAL mode plus `busy_timeout`. A test with 6 processes writing 180 memories in parallel lost no writes and created no duplicates.
- **Search index.** The `memories_fts` FTS5 table is kept in sync by triggers. Its `rowid` equals `memories.seq` (an `INTEGER PRIMARY KEY`), so it stays aligned after a `VACUUM`.
- **Retrieval.** A retriever returns candidate ids with text scores. The engine then re-ranks them as 0.70·text + 0.15·importance + 0.10·confidence + w·recency.
- **Retriever interface.** `Retriever` declares `kind: 'keyword' | 'semantic'`. A future embedding-based retriever can plug in through `registerEmbeddingProvider`. No embedding provider ships in v0.1.
- **Logging.** Logs are JSON lines on stderr. Memory content is never logged.
