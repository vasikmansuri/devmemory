/**
 * Secret detection and redaction. Runs on every write path (save, update, import)
 * before anything touches the database, and again on MCP output as defence in depth.
 *
 * Detection is pattern-based and therefore imperfect: it catches common credential
 * formats, not every possible secret. See docs/security-model.md.
 */
export interface SecretPattern {
  kind: string;
  regex: RegExp;
  /** Capture group holding the secret value; 0 = whole match. */
  group?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    kind: 'private_key',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'aws_access_key_id', regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws_secret_access_key',
    regex: /(aws_?secret_?access_?key|aws_?secret)["'\s]*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    group: 2,
  },
  { kind: 'github_token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: 'gitlab_token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack_token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'slack_webhook', regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { kind: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'anthropic_api_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai_api_key', regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'pypi_token', regex: /\bpypi-[A-Za-z0-9_-]{50,}\b/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer_token', regex: /\b(Bearer)\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 2 },
  {
    kind: 'url_credentials',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi,
    group: 2,
  },
  {
    kind: 'credential_assignment',
    regex:
      /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token))\b(["']?\s*[:=]\s*)(["']?)([^\s"'`,;]{6,})\3/gi,
    group: 4,
  },
];

export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

const PLACEHOLDER = /^\[REDACTED:[a-z_]+\]$/;
// Values that look like references to secrets rather than secrets themselves.
const BENIGN_VALUE =
  /^(?:\$\{?[A-Z0-9_]+\}?|process\.env\.[A-Za-z0-9_]+|<[^>]+>|\*+|x+|changeme|example|placeholder|redacted|true|false|null|none|undefined)$/i;

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const { kind, regex, group = 0 } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    text = text.replace(regex, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as (string | undefined)[];
      const secret = group === 0 ? match : groups[group - 1];
      if (!secret || PLACEHOLDER.test(secret) || BENIGN_VALUE.test(secret) || secret.includes('[REDACTED:')) {
        return match;
      }
      count++;
      kinds.add(kind);
      const replacement = `[REDACTED:${kind}]`;
      if (group === 0) return replacement;
      // Rebuild the match, replacing only the secret group.
      const idx = match.lastIndexOf(secret);
      return match.slice(0, idx) + replacement + match.slice(idx + secret.length);
    });
  }
  return { text, count, kinds: [...kinds] };
}

export function containsSecret(input: string): boolean {
  return redactSecrets(input).count > 0;
}
