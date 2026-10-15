# Memory model

## Tables

The database schema is at version 2 and has these tables:

| Table                  | Contents                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `projects`             | One row per project: id, name, canonical root path (unique), timestamps.                                             |
| `memories`             | The memories themselves (fields below).                                                                              |
| `tags` / `memory_tags` | Tags are scoped per project. Tags no memory uses any more are deleted automatically.                                 |
| `memory_links`         | Links between memories: `relates_to`, `supersedes`, `conflicts_with`, `depends_on`, `duplicates`.                    |
| `memory_events`        | Audit trail: `created`, `updated` (with previous values), `superseded`, `archived`, `linked`, `imported`, `deleted`. |
| `memories_fts`         | FTS5 full-text index over title, content and tags.                                                                   |
| `schema_migrations`    | Migrations that have been applied.                                                                                   |

## Memory fields

- **Identity:** `id` (`mem_` followed by 25 base32 characters, sortable by time) and `project_id`.
- **Content:** `type`, `title` (up to 200 characters), `content` (up to 20,000 characters), and `tags` (up to 20, each up to 50 characters).
- **Ranking signals:** `importance` (1–5, default 3) and `confidence` (0–1, default 0.8).
- **Status:** `active`, `superseded` or `archived`.
- **Provenance:** `source` (`cli`, `mcp`, `import` or `api`), `client`, and an optional `source_ref` (a file, commit, PR or URL).
- **Timestamps:** `created_at`, `updated_at`, `last_accessed_at`, `access_count`, and an optional `expires_at`.
- **Bookkeeping:** `content_hash` (SHA-256), `superseded_by`, and `redactions` (how many secrets were removed before storage).

## Lifecycle rules

- **Duplicates:** two memories with the same type, title and content in the same project count as duplicates. Whitespace differences are ignored but case differences are not. A duplicate save returns the existing memory with `status: "duplicate"` and stores nothing.
- **Conflicts:** if a new memory has the same title as an existing one but different content, both are kept and a `conflicts_with` link is created between them. Similar content (word overlap of 0.6 or more) is reported in `possibleConflicts` only, without a link.
- **Supersede:** the old memory becomes `superseded` and gains a `superseded_by` pointer and a link to its replacement. It stays retrievable by id, but searches skip it unless you ask for superseded memories.
- **Expiry:** expired memories are left out of search, list and context results by default, but they are never deleted automatically.
- **Delete:** a hard delete removes the memory's row, tags, links and search-index entry, and clears the details stored in its audit events. The search index is then optimized and the write-ahead log checkpointed, so the deleted text doesn't linger on disk.
- **Raw conversations:** full conversations are never stored. Only the explicit memories you save are kept.
