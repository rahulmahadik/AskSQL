/**
 * Lightweight, deterministic schema matching used by the repair loop: detecting
 * structure ("show tables") questions, the per-dialect catalog-listing query, and
 * fuzzy table-name matching for a likely misspelling. No model calls.
 */

import type { EngineKind, SchemaCatalog } from './types.js';

/** Questions about the database's own structure rather than its rows. */
const METADATA_INTENT =
  /\b(show|list|display|describe|enumerate|count|name|get|give|tell|see|view|what(?:'s| is| are)?|which|how many|do (?:you|we) have|are there|exist)\b/i;
const METADATA_OBJECT =
  /\b(tables?|collections?|columns?|fields?|schemas?|views?|indexes|indices|relationships?|foreign keys?|primary keys?|(?:database|db|data) (?:structure|layout|schema))\b/i;

export function isMetadataQuestion(question: string): boolean {
  return METADATA_INTENT.test(question) && METADATA_OBJECT.test(question);
}

/** Each engine's read-only way to list tables; system schemas are exempt from the hallucination floor. */
export function catalogQueryHint(engine: EngineKind): string {
  switch (engine) {
    case 'sqlite':
      return "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')";
    case 'mysql':
      return 'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE()';
    case 'oracle':
      return 'SELECT table_name FROM all_tables';
    default:
      return "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')";
  }
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

/** A real table name that's a likely misspelling of a question word, so a refusal can retry with the real name. */
export function closestTableName(question: string, catalog: SchemaCatalog): string | null {
  const words = new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const word of words)
    for (const table of catalog.tables) {
      const name = table.name.toLowerCase();
      if (name === word) continue;
      const threshold = Math.max(1, Math.floor(Math.min(word.length, name.length) / 4));
      const distance = levenshtein(word, name);
      if (distance <= threshold && distance < bestDistance) {
        bestDistance = distance;
        best = table.name;
      }
    }
  return best;
}
