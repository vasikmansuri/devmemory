# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting instead: open the **Security** tab of the repository and click **Report a vulnerability**. Expect a first response within 7 days.

## Supported versions

Only the latest `0.x` release receives fixes.

## Scope and guarantees

DevMemory is local-first. It has no telemetry, opens no network listener, and calls no external APIs. See [docs/security-model.md](docs/security-model.md) for the full threat model.

Known limitations:

- **The database is not encrypted at rest.** It is protected only by file permissions (mode 0600 inside a 0700 directory). Use full-disk encryption if you need more.
- **Secret detection is pattern-based**, so it is not exhaustive.
- **Provenance `client` values are self-reported** by MCP clients and are not authenticated.
