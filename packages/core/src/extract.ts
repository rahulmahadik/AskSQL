/**
 * SQL extraction from model output.
 * Robust to fenced blocks, prose wrapping, and multiple fences.
 */

// Any language tag is consumed (```sql, ```postgresql, ```oracle, ```plsql, ...); the
// candidate is still gated by SQL_START_RE, so a non-SQL fence can't slip through.
const FENCE_RE = /```[A-Za-z0-9+_-]*\s*\n?([\s\S]*?)```/gu;

/**
 * Any statement-shaped start - including write/DDL verbs. Extraction is
 * deliberately permissive so that a model replying with e.g. DELETE is
 * still captured and handed to the guard, which produces the authoritative
 * GUARD_BLOCKED verdict (a clear "not allowed") rather than a vague
 * "no SQL found". The guard, not the extractor, decides what may run.
 */
const SQL_START_RE =
  /^(select|with|explain|show|describe|desc|pragma|insert|update|delete|drop|create|alter|truncate|merge|replace|call|grant|revoke|copy|values|table)\b/iu;

/** Conservative set for inline extraction from prose - read verbs only, to
 * avoid grabbing English sentences that begin with "Update"/"Insert". */
const INLINE_START_RE = /(?:^|\n)\s*((?:select|with|explain)\b[\s\S]*?)(?=\n\s*\n|$)/iu;

export interface Extraction {
  readonly sql: string;
  readonly explanation: string;
  readonly source: 'fence' | 'inline' | 'whole';
}

/** Sentinel the prompt asks the model to emit when a question is unanswerable. */
export const IMPOSSIBLE_SENTINEL = /^\s*IMPOSSIBLE\s*:\s*(.+)/su;

const REASON_MAX_LENGTH = 300;
/** The sentinel word is internal protocol; a model that repeats it mid-sentence must not leak it into the chat. */
const SENTINEL_WORD = /\bIMPOSSIBLE\b\s*:?\s*/gi;
/** "Your question isn't about this data" said many robotic ways; all collapse to one plain sentence. */
const OFF_TOPIC =
  /\b(the )?question (cannot be answered|is not|isn't)\b[^.]*\b(not related to|unrelated to|does not relate)\b|\bnot related to the (provided )?schema\b/i;
/** Model-speak to plain English, applied in order. Deterministic, no second model call. */
const PHRASINGS: readonly (readonly [RegExp, string])[] = [
  [/\bthe provided schema\b/gi, 'this database'],
  [/\bthe (given |current )?schema\b/gi, 'this database'],
  [/\bdoes not contain any information (about|on|related to)\b/gi, "doesn't have anything about"],
  [/\bdoes not contain any\b/gi, "doesn't have any"],
  [/\bdoes not contain\b/gi, "doesn't have"],
  [/\bdoes not (include|have|provide)\b/gi, "doesn't have"],
  [/\bis not able to\b|\bcannot be\b/gi, "can't be"],
];

function humanizeReason(reason: string): string {
  if (OFF_TOPIC.test(reason)) return "That question isn't about the data in this database.";
  let out = reason;
  for (const [pattern, replacement] of PHRASINGS) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, ' ').trim();
}

function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The prompt asks for "IMPOSSIBLE: <one-line reason>"; a noncompliant model rambles on, so only
 * the first line is the reason, the sentinel word is stripped, and stiff phrasing is humanized.
 */
export function extractImpossible(text: string): string | null {
  const m = IMPOSSIBLE_SENTINEL.exec(text.trim());
  if (!m) return null;
  const firstLine = m[1]!.trim().split('\n')[0]!.trim();
  const cleaned = firstLine.replace(SENTINEL_WORD, '').trim();
  const humanized = humanizeReason(cleaned);
  const sentenceCased = humanized.charAt(0).toUpperCase() + humanized.slice(1);
  return truncateAtWordBoundary(sentenceCased, REASON_MAX_LENGTH);
}

export function extractSql(text: string): Extraction | null {
  const raw = text ?? '';

  // 1) Fenced blocks - first block that looks like a query wins.
  const fences = [...raw.matchAll(FENCE_RE)];
  for (const f of fences) {
    const candidate = (f[1] ?? '').trim();
    if (candidate && SQL_START_RE.test(candidate)) {
      const explanation = raw.replace(f[0]!, ' ').replace(/```[\s\S]*?```/gu, ' ');
      return { sql: candidate, explanation: tidy(explanation), source: 'fence' };
    }
  }

  // 2) Whole message is SQL.
  const trimmed = raw.trim();
  if (SQL_START_RE.test(trimmed)) {
    return { sql: trimmed, explanation: '', source: 'whole' };
  }

  // 3) Inline: first SELECT/WITH run up to a blank line or end.
  const inline = INLINE_START_RE.exec(raw);
  if (inline) {
    const sql = inline[1]!.trim();
    if (sql.length > 8) {
      return { sql, explanation: tidy(raw.replace(inline[1]!, ' ')), source: 'inline' };
    }
  }
  return null;
}

function tidy(explanation: string): string {
  return explanation.replace(/\s+/gu, ' ').trim().slice(0, 2000);
}
