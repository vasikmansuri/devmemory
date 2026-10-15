# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-15

### Changed

- Published as `@vasikmansuri/devmemory`; new README with diagrams, npm keywords and repository metadata.

## [0.1.0] - 2026-10-15

### Added

- Project-scoped memory engine on SQLite. The database runs in WAL mode with foreign keys and `secure_delete`. Schema changes use versioned migrations, with an automatic backup before each migration.
- Seven memory types (`decision`, `architecture`, `debugging`, `convention`, `constraint`, `task_context`, `fact`), plus configurable extra types.
- Core operations: save, get, update (previous values are kept in history), supersede, archive, hard delete, list, link, stats, context bundles, import and export.
- Exact-duplicate detection, and reporting of conflicts for memories with the same title or similar content.
- Keyword retrieval with SQLite FTS5 and BM25 ranking. Results are ranked with explainable scores, and a LIKE-based fallback is used when FTS5 is unavailable.
- Secret redaction on every write and on MCP output.
- MCP server over stdio (MCP TypeScript SDK v2) with 9 tools.
- CLI with 15 commands.
- Path-safe import and export: path traversal and symlinks are rejected, exports are written with mode 0600, and imports are limited to 10 MB.
- Retrieval evaluation: 36 labelled queries.
- Verified Claude Code integration. The Cursor configuration is documented but not tested end to end.
