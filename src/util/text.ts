import { createHash } from 'node:crypto';

/**
 * Canonicalise user text before storage: Unicode NFC, LF line endings,
 * and removal of control characters (keeping tab and newline).
 */
export function normalizeText(input: string): string {
  return (
    input
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
  );
}

/** Whitespace-insensitive form used for duplicate detection. Case is preserved on purpose. */
export function canonicalForHash(text: string): string {
  return normalizeText(text).replace(/\s+/g, ' ');
}

export function contentHash(type: string, title: string, content: string): string {
  return createHash('sha256')
    .update(`${type}\u0000${canonicalForHash(title)}\u0000${canonicalForHash(content)}`)
    .digest('hex');
}

/** Rough token estimate (~4 chars/token for English, conservative for CJK). Deterministic. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.codePointAt(0)! > 0x2e80 ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/** Truncate to approximately `maxTokens`, cutting on a word boundary when possible. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const cost = ch.codePointAt(0)! > 0x2e80 ? 1 : 0.25;
    if (used + cost > maxTokens) break;
    out += ch;
    used += cost;
  }
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > out.length * 0.7) out = out.slice(0, lastSpace);
  return `${out.trimEnd()}…`;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;

export function words(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(WORD_RE) ?? []) as string[];
}

/** Jaccard similarity of word sets; used to flag near-duplicate / potentially conflicting memories. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(words(a));
  const sb = new Set(words(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}
