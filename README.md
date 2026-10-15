# DevMemory

Local-first persistent project memory for AI coding agents, served over MCP (stdio) and a CLI. SQLite + FTS5. No cloud, no telemetry, no network listener.

## Install

Node.js ≥ 22.12.

```bash
npm install -g @vasikmansuri/devmemory   # installs the `devmemory` command

# or from source
git clone <repo-url> devmemory && cd devmemory
npm ci && npm run build && npm link
```

## Quick start

```bash
cd ~/code/my-app
devmemory init
devmemory remember -t decision --title "Use Drizzle ORM" -c "Prisma breaks on edge runtimes." --tags db -i 4
devmemory search "which orm"
devmemory context "touching the data layer"
```

## Connect an agent

**Claude Code** (verified end to end with 2.1.294):

```bash
claude mcp add --transport stdio devmemory -- devmemory mcp
```

The server resolves the project from the directory where `claude` is launched, walking up to the nearest registered project. If you also pass `--env`, put another option between `--env` and the server name.

**Cursor** (config written to Cursor's documented format; **not tested end to end**). Put this in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "devmemory": {
      "type": "stdio",
      "command": "devmemory",
      "args": ["mcp", "--project", "${workspaceFolder}"]
    }
  }
}
```

## CLI

`init`, `remember`, `search`, `get`, `list`, `context`, `update`, `forget` (archives by default; `--hard --yes` deletes), `link`, `stats`, `export`, `import`, `projects`, `doctor`, `mcp`. Run `devmemory <cmd> --help` for the options.

Exit codes: 0 ok, 1 internal error, 2 validation, 3 not found, 4 project not initialized, 5 conflict, 6 database error, 7 I/O or unsafe path.

## MCP tools

`memory_save`, `memory_search`, `memory_get`, `memory_update`, `memory_forget`, `memory_list`, `memory_context`, `memory_link`, `memory_stats`. Each server is bound to one project, and no tool takes a project id.

## Configuration

These environment variables are supported:

| Variable                    | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| `DEVMEMORY_HOME`            | Data directory. Default `~/.devmemory`.              |
| `DEVMEMORY_DB`              | Path to the database file.                           |
| `DEVMEMORY_PROJECT`         | Project directory to use instead of the current one. |
| `DEVMEMORY_SECRET_POLICY`   | `redact` (default) or `reject`.                      |
| `DEVMEMORY_EXTRA_TYPES`     | Comma-separated list of extra memory types.          |
| `DEVMEMORY_BUSY_TIMEOUT_MS` | How long a writer waits for a database lock.         |
| `DEVMEMORY_LOG_LEVEL`       | Log verbosity. Logs go to stderr.                    |

## Retrieval (measured)

Measured with FTS5 on 36 labelled queries:

- **All queries:** Recall@5 0.944, Precision@5 0.217 (the maximum achievable here is 0.228), MRR 0.922.
- **Paraphrased queries:** Recall@5 0.75.

The metrics come from `npm run eval`. Search is keyword-based, not semantic.

## Security notes

- Secrets are redacted before storage, using pattern matching, so detection is not exhaustive.
- Retrieved memories are wrapped as untrusted data.
- Hard deletes also purge the search index.
- The database file is created with mode 0600 but is **not encrypted**.
- Import and export reject path traversal and symlinks.

## Development

```bash
npm run check   # typecheck, lint, format, 129 tests, build
npm run demo    # real fresh-session and isolation demo
```

## Limitations

- No semantic search.
- CJK text is tokenized coarsely.
- Project identity is the directory path, so moving a project means running `init` again.
- Client identity in provenance is self-reported by the MCP client.
- The Cursor integration is unverified.

## License

MIT. Runtime dependencies are MIT or Apache-2.0.

Note: Windows is tested on Node 24 and 26. On Windows + Node 22, `better-sqlite3` currently needs a local C++ build toolchain.

## Documentation

[Architecture](docs/architecture.md) · [Memory model](docs/memory-model.md) · [Security model](docs/security-model.md) · [MCP integration](docs/mcp-integration.md) · [Troubleshooting](docs/troubleshooting.md) · [Retrieval evaluation](docs/retrieval-evaluation.md) · [Roadmap](docs/roadmap.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)
