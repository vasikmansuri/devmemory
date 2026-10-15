# MCP integration

The server runs as `devmemory mcp [--project <dir>] [--init]` over stdio. It chooses its project in this order:

1. the `--project` flag;
2. the `DEVMEMORY_PROJECT` environment variable;
3. the nearest registered ancestor of the directory it was started in.

## Claude Code: verified with 2.1.294 on macOS

1. **Install:** `npm i -g @vasikmansuri/devmemory` (or `npm link` from a source checkout).
2. **Initialize your project:** `cd your-project && devmemory init`
3. **Register the server.** For your own use:
   ```bash
   claude mcp add --transport stdio devmemory -- devmemory mcp
   ```
   To share it with your team via `.mcp.json`:
   ```bash
   claude mcp add --scope project --transport stdio devmemory -- devmemory mcp
   ```
   If you pass `--env KEY=value`, put another option such as `--transport stdio` between `--env` and the server name. Otherwise the CLI reads the name as another environment variable.
4. **Verify:** run `claude mcp list` or `/mcp`. Project-scoped servers show `⏸ Pending approval` until you start `claude` and approve them.
5. **Save a memory:** ask "Save to DevMemory: we use X because Y".
6. **Start a fresh session:** exit Claude Code and run `claude` again.
7. **Retrieve it:** ask a question about the topic. Claude calls `memory_context` or `memory_search`, and the answer cites the memory id and its provenance.
8. **Check isolation:** start a session in another initialized project and ask the same question. The search returns 0 results.

Tested by:

- running `claude -p` sessions with `--mcp-config .mcp.json --strict-mcp-config`;
- a save in session 1, then a new session that retrieved it;
- a session in a second project that returned 0 results.

Claude Code starts stdio servers in the directory where `claude` was launched (it also sets `CLAUDE_PROJECT_DIR`). DevMemory walks up from there to the registered root, so the shared config above works from any subdirectory.

## Cursor: not verified end to end

Put this in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global), following Cursor's documented format:

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

To verify, find the server under **Customize** in Cursor's sidebar. Then open the Output panel (Cmd/Ctrl+Shift+U) and select **MCP Logs** to see the connection. No Cursor CLI was available, so this setup has not been exercised end to end.

## Tool reference

All tools validate their inputs with Zod and declare output schemas. Errors come back as `isError: true` with a body of `{"error": {"code", "message", "hint?"}}`.

| Tool             | Notes                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| `memory_save`    | `supersedes` replaces an existing memory. The result includes `possibleConflicts`. |
| `memory_search`  | Default status filter is `active`. Maximum 50 results.                             |
| `memory_get`     | `includeHistory` adds the audit trail.                                             |
| `memory_update`  | Previous values are kept in the audit trail.                                       |
| `memory_forget`  | Archives by default. `mode: "delete"` also needs `confirm: true`.                  |
| `memory_list`    | Paginated with `limit` and `offset`.                                               |
| `memory_context` | `maxTokens` from 100 to 16,000, default 2,000.                                     |
| `memory_link`    | Creates a typed link between two memories.                                         |
| `memory_stats`   | Counts and retrieval info for the project.                                         |
