/**
 * Retrieval evaluation corpus: a fictional e-commerce project ("ShopFlow").
 * Each query lists the memory keys a competent engineer would consider relevant.
 * Some queries deliberately use vocabulary that differs from the stored text
 * (paraphrases) — keyword retrieval is expected to miss some of those, and the
 * measured numbers are reported as-is in docs/retrieval-evaluation.md.
 */
export interface CorpusMemory {
  key: string;
  type: string;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
}

export const CORPUS: CorpusMemory[] = [
  {
    key: 'db-choice',
    type: 'decision',
    title: 'PostgreSQL is the primary database',
    content:
      'We chose PostgreSQL 16 over MySQL for JSONB support, partial indexes and row-level security. All services share one cluster with separate schemas.',
    tags: ['database', 'postgres'],
    importance: 5,
  },
  {
    key: 'orm',
    type: 'decision',
    title: 'Drizzle ORM for data access',
    content:
      'Data access uses Drizzle ORM with typed schema definitions in packages/db. Prisma was rejected because its engine binary breaks on edge runtimes.',
    tags: ['database', 'orm'],
    importance: 4,
  },
  {
    key: 'migrations',
    type: 'convention',
    title: 'Database migrations workflow',
    content:
      'Generate migrations with drizzle-kit generate, review the SQL by hand, and never edit a migration after it is merged. Migrations run in CI before deploy.',
    tags: ['database', 'migrations'],
  },
  {
    key: 'migration-lock',
    type: 'debugging',
    title: 'Deadlock when two pods ran migrations',
    content:
      'Two Kubernetes pods ran migrations concurrently at startup and deadlocked. Fix: migrations run once as a pre-deploy job holding a pg_advisory_lock.',
    tags: ['database', 'kubernetes'],
  },
  {
    key: 'cache',
    type: 'architecture',
    title: 'Redis caching layer',
    content:
      'Product catalogue reads are cached in Redis with a 10 minute TTL. Cache keys are namespaced by tenant id. Writes invalidate keys via a pub/sub channel.',
    tags: ['cache', 'redis'],
  },
  {
    key: 'cache-stampede',
    type: 'debugging',
    title: 'Cache stampede on Black Friday',
    content:
      'When popular product keys expired simultaneously, thousands of requests hit Postgres at once. Fixed with probabilistic early expiration and a per-key mutex.',
    tags: ['cache', 'performance'],
  },
  {
    key: 'auth',
    type: 'architecture',
    title: 'Authentication with short-lived JWTs',
    content:
      'Users authenticate through the auth service which issues 15 minute JWT access tokens and rotating refresh tokens stored in httpOnly cookies.',
    tags: ['auth', 'security'],
    importance: 5,
  },
  {
    key: 'oauth',
    type: 'decision',
    title: 'Social login via OAuth providers',
    content:
      'Google and Apple sign-in are implemented with OAuth 2.0 PKCE flows. GitHub login was dropped because customers rarely used it.',
    tags: ['auth'],
  },
  {
    key: 'session-bug',
    type: 'debugging',
    title: 'Users logged out after deploy',
    content:
      'After deploys users were logged out because the JWT signing key was regenerated on boot. Signing keys now load from the secrets manager and rotate with overlap.',
    tags: ['auth', 'deploy'],
  },
  {
    key: 'rbac',
    type: 'architecture',
    title: 'Role-based access control',
    content:
      'Permissions use RBAC with roles admin, staff and customer. Checks live in a single authorize() helper; never check roles inline in route handlers.',
    tags: ['auth', 'security'],
  },
  {
    key: 'payments',
    type: 'architecture',
    title: 'Payments through Stripe',
    content:
      'Checkout creates a Stripe PaymentIntent. Webhooks from Stripe confirm payment and are the source of truth for order status.',
    tags: ['payments', 'stripe'],
    importance: 4,
  },
  {
    key: 'webhook-idem',
    type: 'debugging',
    title: 'Duplicate orders from webhook retries',
    content:
      'Stripe retried webhooks after our handler timed out, creating duplicate orders. Webhook handlers are now idempotent using the event id as a unique key.',
    tags: ['payments', 'webhooks'],
  },
  {
    key: 'currency',
    type: 'constraint',
    title: 'Money is stored in minor units',
    content:
      'All monetary amounts are integers in minor units (cents) with an ISO 4217 currency code. Floating point is forbidden for money.',
    tags: ['payments'],
    importance: 5,
  },
  {
    key: 'tax',
    type: 'fact',
    title: 'Sales tax calculation provider',
    content:
      'Sales tax and VAT are calculated by TaxJar at checkout; rates are not cached longer than 24 hours.',
    tags: ['payments', 'tax'],
  },
  {
    key: 'queue',
    type: 'decision',
    title: 'Background jobs on BullMQ',
    content:
      'Asynchronous work (emails, image resizing, exports) runs on BullMQ queues backed by Redis. Jobs must be idempotent and safe to retry.',
    tags: ['jobs', 'redis'],
  },
  {
    key: 'email',
    type: 'fact',
    title: 'Transactional email provider',
    content:
      'Order confirmation and password reset emails are sent through Postmark using templates stored in the dashboard.',
    tags: ['email'],
  },
  {
    key: 'images',
    type: 'architecture',
    title: 'Product image pipeline',
    content:
      'Uploaded product images go to S3, a BullMQ worker resizes them with sharp into WebP variants, and CloudFront serves them.',
    tags: ['images', 's3'],
  },
  {
    key: 'sharp-alpine',
    type: 'debugging',
    title: 'sharp crashes on Alpine images',
    content:
      'The image worker segfaulted on Alpine because sharp needs glibc. Docker images now use the debian-slim base.',
    tags: ['images', 'docker'],
  },
  {
    key: 'search',
    type: 'decision',
    title: 'Product search with Meilisearch',
    content:
      'Storefront search uses Meilisearch for typo tolerance and faceting. The index is updated from Postgres change events.',
    tags: ['search'],
  },
  {
    key: 'frontend',
    type: 'architecture',
    title: 'Storefront built with Next.js',
    content:
      'The storefront is a Next.js App Router application using React Server Components and edge rendering for product pages.',
    tags: ['frontend', 'nextjs'],
  },
  {
    key: 'styling',
    type: 'convention',
    title: 'Tailwind CSS for styling',
    content:
      'UI styling uses Tailwind CSS v4 with design tokens defined in tailwind.config. No CSS-in-JS libraries.',
    tags: ['frontend', 'css'],
  },
  {
    key: 'state',
    type: 'decision',
    title: 'Client state with Zustand',
    content:
      'Client-side state (cart drawer, filters) uses Zustand. Server data is fetched with TanStack Query; Redux was removed in 2025.',
    tags: ['frontend'],
  },
  {
    key: 'hydration',
    type: 'debugging',
    title: 'Hydration mismatch from dates',
    content:
      'Product pages threw hydration mismatch errors because dates rendered in server timezone. Dates are now formatted on the client only.',
    tags: ['frontend', 'nextjs'],
  },
  {
    key: 'a11y',
    type: 'constraint',
    title: 'WCAG 2.2 AA accessibility required',
    content: 'All storefront pages must meet WCAG 2.2 AA. Every PR touching UI runs axe checks in CI.',
    tags: ['frontend', 'accessibility'],
    importance: 5,
  },
  {
    key: 'api-style',
    type: 'decision',
    title: 'REST API with OpenAPI spec',
    content:
      'The public API is REST/JSON described by an OpenAPI 3.1 document generated from Zod schemas. GraphQL was considered and rejected.',
    tags: ['api'],
  },
  {
    key: 'api-versioning',
    type: 'convention',
    title: 'API versioning in the URL path',
    content:
      'Breaking API changes get a new /v2 path prefix; old versions are supported for 12 months after deprecation notice.',
    tags: ['api'],
  },
  {
    key: 'rate-limit',
    type: 'architecture',
    title: 'Rate limiting at the gateway',
    content:
      'The API gateway enforces token bucket rate limits per API key: 100 requests per minute by default, stored in Redis.',
    tags: ['api', 'redis'],
  },
  {
    key: 'errors',
    type: 'convention',
    title: 'Error response format',
    content:
      'API errors follow RFC 9457 problem+json with a stable machine-readable code field. Never leak stack traces to clients.',
    tags: ['api'],
  },
  {
    key: 'logging',
    type: 'convention',
    title: 'Structured logging with pino',
    content:
      'Services log JSON with pino. Include request id and tenant id; never log personal data or payment details.',
    tags: ['observability'],
  },
  {
    key: 'tracing',
    type: 'architecture',
    title: 'Distributed tracing with OpenTelemetry',
    content:
      'All services export OpenTelemetry traces to Grafana Tempo. Trace context propagates through BullMQ job metadata.',
    tags: ['observability'],
  },
  {
    key: 'alerts',
    type: 'fact',
    title: 'On-call alerting',
    content: 'PagerDuty pages the on-call engineer when checkout error rate exceeds 2% for five minutes.',
    tags: ['observability', 'oncall'],
  },
  {
    key: 'ci',
    type: 'architecture',
    title: 'CI pipeline on GitHub Actions',
    content:
      'GitHub Actions runs lint, typecheck, unit tests and Playwright end-to-end tests on every pull request. Main is protected.',
    tags: ['ci'],
  },
  {
    key: 'flaky-e2e',
    type: 'debugging',
    title: 'Flaky Playwright tests',
    content:
      'End-to-end tests were flaky because they shared a seeded database. Each test worker now gets its own schema created from a template.',
    tags: ['ci', 'testing'],
  },
  {
    key: 'testing',
    type: 'convention',
    title: 'Testing conventions',
    content:
      'Unit tests use Vitest and live next to the code as *.test.ts. Mock network calls with MSW, never with ad-hoc fetch stubs.',
    tags: ['testing'],
  },
  {
    key: 'deploy',
    type: 'architecture',
    title: 'Deployment to Kubernetes',
    content:
      'Services deploy to EKS via Argo CD. Each merge to main builds an image, and Argo syncs the staging environment automatically.',
    tags: ['deploy', 'kubernetes'],
  },
  {
    key: 'release',
    type: 'convention',
    title: 'Production release process',
    content:
      'Production releases are promoted from staging by tagging a release; a human approves the Argo sync. Friday afternoon releases are not allowed.',
    tags: ['deploy'],
  },
  {
    key: 'secrets',
    type: 'constraint',
    title: 'Secrets management',
    content:
      'Secrets live in AWS Secrets Manager and are injected at runtime. Never commit .env files; gitleaks runs in CI.',
    tags: ['security'],
    importance: 5,
  },
  {
    key: 'gdpr',
    type: 'constraint',
    title: 'GDPR data retention',
    content:
      'Customer personal data must be deletable on request within 30 days, and order data older than 7 years is purged.',
    tags: ['compliance', 'privacy'],
    importance: 5,
  },
  {
    key: 'node',
    type: 'constraint',
    title: 'Node.js 22 runtime',
    content: 'All services target Node.js 22 LTS. Do not use APIs that require newer versions.',
    tags: ['runtime'],
  },
  {
    key: 'monorepo',
    type: 'architecture',
    title: 'pnpm monorepo layout',
    content:
      'The repository is a pnpm workspace with apps/ (storefront, admin, api) and packages/ (db, ui, config). Turborepo caches builds.',
    tags: ['tooling'],
  },
  {
    key: 'lint',
    type: 'convention',
    title: 'Linting and formatting',
    content:
      'ESLint flat config plus Prettier with 100 character lines. Imports are sorted automatically; do not disable rules inline without a comment.',
    tags: ['tooling'],
  },
  {
    key: 'commits',
    type: 'convention',
    title: 'Conventional commits',
    content:
      'Commit messages follow Conventional Commits (feat:, fix:, chore:) so changelogs can be generated.',
    tags: ['tooling', 'git'],
  },
  {
    key: 'inventory',
    type: 'architecture',
    title: 'Inventory reservations',
    content:
      'Stock is reserved when checkout starts and released after 15 minutes if payment does not complete, using a scheduled BullMQ job.',
    tags: ['inventory', 'checkout'],
  },
  {
    key: 'oversell',
    type: 'debugging',
    title: 'Overselling during flash sales',
    content:
      'Concurrent checkouts oversold limited stock because reservation used read-then-write. Now uses an atomic UPDATE ... WHERE stock >= quantity.',
    tags: ['inventory', 'database'],
  },
  {
    key: 'task-refactor',
    type: 'task_context',
    title: 'Current task: split checkout service',
    content:
      'In progress: extracting checkout from the monolith API into its own service. Next step is moving the Stripe webhook handler.',
    tags: ['checkout'],
  },
  {
    key: 'i18n',
    type: 'fact',
    title: 'Localization setup',
    content:
      'The storefront supports English, German and French using next-intl; translation files live in apps/storefront/messages.',
    tags: ['frontend', 'i18n'],
  },
];

export interface EvalQuery {
  query: string;
  relevant: string[];
  /** 'direct' shares vocabulary with the target; 'paraphrase' deliberately does not. */
  kind: 'direct' | 'paraphrase';
}

export const QUERIES: EvalQuery[] = [
  { query: 'which database do we use', relevant: ['db-choice'], kind: 'direct' },
  { query: 'ORM for database access', relevant: ['orm'], kind: 'direct' },
  { query: 'how do we run database migrations', relevant: ['migrations', 'migration-lock'], kind: 'direct' },
  { query: 'migration deadlock on startup', relevant: ['migration-lock'], kind: 'direct' },
  { query: 'redis cache TTL', relevant: ['cache'], kind: 'direct' },
  {
    query: 'too many requests hit postgres when cache keys expire',
    relevant: ['cache-stampede'],
    kind: 'direct',
  },
  { query: 'JWT access token lifetime', relevant: ['auth'], kind: 'direct' },
  { query: 'Google sign-in OAuth', relevant: ['oauth'], kind: 'direct' },
  { query: 'users logged out after deploy', relevant: ['session-bug'], kind: 'direct' },
  { query: 'where are permission checks done', relevant: ['rbac'], kind: 'direct' },
  { query: 'stripe webhooks', relevant: ['payments', 'webhook-idem'], kind: 'direct' },
  { query: 'duplicate orders', relevant: ['webhook-idem'], kind: 'direct' },
  { query: 'how to store money amounts', relevant: ['currency'], kind: 'direct' },
  { query: 'background jobs queue', relevant: ['queue'], kind: 'direct' },
  { query: 'sharp segfault docker alpine', relevant: ['sharp-alpine'], kind: 'direct' },
  { query: 'product image resizing', relevant: ['images'], kind: 'direct' },
  { query: 'storefront search typo tolerance', relevant: ['search'], kind: 'direct' },
  { query: 'hydration mismatch error', relevant: ['hydration'], kind: 'direct' },
  { query: 'accessibility requirements', relevant: ['a11y'], kind: 'direct' },
  { query: 'API versioning policy', relevant: ['api-versioning'], kind: 'direct' },
  { query: 'rate limits per API key', relevant: ['rate-limit'], kind: 'direct' },
  { query: 'error response format for the API', relevant: ['errors'], kind: 'direct' },
  { query: 'flaky playwright end-to-end tests', relevant: ['flaky-e2e'], kind: 'direct' },
  { query: 'kubernetes deployment argo', relevant: ['deploy', 'release'], kind: 'direct' },
  { query: 'GDPR personal data deletion', relevant: ['gdpr'], kind: 'direct' },
  { query: 'overselling stock during flash sale', relevant: ['oversell', 'inventory'], kind: 'direct' },
  { query: 'conventional commit messages', relevant: ['commits'], kind: 'direct' },
  { query: 'what is the current task on checkout', relevant: ['task-refactor'], kind: 'direct' },
  // Paraphrases: little or no shared vocabulary with the target memory.
  { query: 'which SQL engine backs the app', relevant: ['db-choice'], kind: 'paraphrase' },
  { query: 'can I use floats for prices', relevant: ['currency'], kind: 'paraphrase' },
  { query: 'when am I allowed to ship to prod', relevant: ['release'], kind: 'paraphrase' },
  { query: 'where do credentials and API keys live', relevant: ['secrets'], kind: 'paraphrase' },
  { query: 'how are pages translated into other languages', relevant: ['i18n'], kind: 'paraphrase' },
  { query: 'who gets woken up when checkout breaks', relevant: ['alerts'], kind: 'paraphrase' },
  {
    query: 'how do we observe requests across services',
    relevant: ['tracing', 'logging'],
    kind: 'paraphrase',
  },
  { query: 'which runtime version should code target', relevant: ['node'], kind: 'paraphrase' },
];
