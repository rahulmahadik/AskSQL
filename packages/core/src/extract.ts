/**
 * SQL extraction from model output.
 * Robust to fenced blocks, prose wrapping, and multiple fences.
 */

const FENCE_RE = /```(?:sql|SQL)?\s*\n?([\s\S]*?)```/gu;

/**
 * Any statement-shaped start - INCLUDING write/DDL verbs. Extraction is
 * deliberately permissive so that a model replying with e.g. DELETE is
 * still captured and handed to the guard, which produces the authoritative
 * GUARD_BLOCKED verdict (a clear "not allowed") rather than a vague
 * "no SQL found". The guard, not the extractor, decides what may run.
 */
const SQL_START_RE =
  /^(select|with|explain|show|describe|desc|pragma|insert|update|delete|drop|create|alter|truncate|merge|replace|call|grant|revoke|copy|values|table)\b/iu;

/** Conservative set for INLINE extraction from prose - read verbs only, to
 * avoid grabbing English sentences that begin with "Update"/"Insert". */
const INLINE_START_RE = /(?:^|\n)\s*((?:select|with|explain)\b[\s\S]*?)(?=\n\s*\n|$)/iu;

export interface Extraction {
  readonly sql: string;
  readonly explanation: string;
  readonly source: 'fence' | 'inline' | 'whole';
}

/** Sentinel the prompt asks the model to emit when a question is unanswerable. */
export const IMPOSSIBLE_SENTINEL = /^\s*IMPOSSIBLE\s*:\s*(.+)/su;

export function extractImpossible(text: string): string | null {
  const m = IMPOSSIBLE_SENTINEL.exec(text.trim());
  if (!m) return null;
  return m[1]!.trim().slice(0, 500);
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
