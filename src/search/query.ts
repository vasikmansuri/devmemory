import { words } from '../util/text.js';

// Small English stopword list: removing these sharpens BM25 for natural-language queries.
const STOPWORDS = new Set(
  (
    'a an and are as at be but by can did do does for from had has have how i if in into is it its ' +
    'me my no not of on or our should so than that the their them then there these they this to ' +
    'up us was we were what when where which who why will with would you your about use used using'
  ).split(' '),
);

const MAX_TERMS = 32;

/** Extract normalised search terms from free text. Falls back to stopwords if nothing else remains. */
export function queryTerms(query: string): string[] {
  const all = words(query).filter((w) => w.length > 0);
  const filtered = all.filter((w) => !STOPWORDS.has(w));
  const terms = filtered.length > 0 ? filtered : all;
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/**
 * Build a safe FTS5 MATCH expression. Every term is double-quoted (so user input can never
 * inject FTS5 operators) and OR-combined; terms of 3+ chars also match as prefixes.
 */
export function buildFtsQuery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms
    .map((t) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return t.length >= 3 ? `${quoted}*` : quoted;
    })
    .join(' OR ');
}
