# Contributing

## Setup

You need Node.js 22.12 or later.

```bash
npm ci
npm run check   # typecheck, lint, format check, tests, build
```

## Guidelines

- **Tests:** every behavior change needs a test. Integration tests spawn the built binary (`dist/cli.js`); the test setup builds it automatically.
- **Retrieval changes:** run `npm run eval` and report the before and after metrics in your PR. Do not lower the regression floors to make a change pass.
- **Logging:** never log memory content. stdout is reserved for MCP JSON-RPC and CLI output, so log to stderr.
- **SQL:** keep it parameterized. Schema changes go in a new migration in `src/db/migrations.ts`; never edit a released migration.
- **Security:** new write paths must go through `sanitize()`, which redacts secrets. New read paths must stay scoped to a single project.
- **Commits:** use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
